// roadmap_sync — port of src/evergreenlabs_bot/pipelines/roadmap_sync.py.
// Fetches GitHub Projects v2 items via GraphQL, drafts one-line LLM commentary
// (cached by updatedAt so unchanged items don't burn tokens), writes the full
// roadmap array to site_parts.roadmap.
//
// Key behaviors preserved from the Python source:
//   - Items with status in HIDDEN_STATUSES are excluded from the output.
//   - Commentary is cached by composite key `id::updatedAt`. If the cached
//     entry matches, the existing commentary is reused (zero LLM cost).
//   - Commentary uses `chat()`, temp 0.3, max 160 tokens.
//   - Output shape matches data/site/roadmap.json.
//   - GraphQL failures are caught and logged — they do NOT crash DailySync.

import type { GhAppEnv } from "../lib/github";
import { chat, type LlmEnv } from "../lib/llm";
import { getSitePart, putSitePart } from "../lib/state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RoadmapEntry {
  id: string;
  title: string;
  status: string;
  priority: string | null;
  kind: string | null;
  url: string | null;
  repo: string | null;
  isDraft: boolean;
  commentary: string;
  updatedAt: string;
}

export interface RoadmapSyncSummary {
  fetched: number;
  kept: number;
  hiddenDone: number;
  commentaryNew: number;
  commentaryCached: number;
  error?: string;
}

export interface RoadmapSyncEnv extends GhAppEnv, LlmEnv {
  DB: D1Database;
  GITHUB_USERNAME: string;
  GITHUB_PROJECT_NUMBER?: string;
  /** Classic PAT with `read:project` scope — GitHub Apps can't access user-owned Projects v2. */
  GITHUB_PAT_PROJECTS: string;
}

// ---------------------------------------------------------------------------
// GraphQL query — ported from src/evergreenlabs_bot/github_projects.py
// ---------------------------------------------------------------------------

const PROJECTS_V2_QUERY = `
query($login: String!, $number: Int!) {
  user(login: $login) {
    projectV2(number: $number) {
      id
      title
      number
      url
      items(first: 100) {
        nodes {
          id
          updatedAt
          type
          content {
            __typename
            ... on Issue {
              number
              title
              body
              url
              state
              repository { nameWithOwner }
            }
            ... on PullRequest {
              number
              title
              body
              url
              state
              repository { nameWithOwner }
            }
            ... on DraftIssue {
              title
              body
            }
          }
          fieldValues(first: 20) {
            nodes {
              __typename
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
              ... on ProjectV2ItemFieldTextValue {
                text
                field { ... on ProjectV2Field { name } }
              }
              ... on ProjectV2ItemFieldNumberValue {
                number
                field { ... on ProjectV2Field { name } }
              }
              ... on ProjectV2ItemFieldDateValue {
                date
                field { ... on ProjectV2Field { name } }
              }
            }
          }
        }
      }
    }
  }
}
`;

// ---------------------------------------------------------------------------
// Prompts — ported verbatim from Python
// ---------------------------------------------------------------------------

const COMMENTARY_SYSTEM = `\
You write one-line context blurbs for items on a developer's public roadmap.
Voice: terse, lowercase, specific. NO hype words (powerful, robust, exciting).
NO meta phrases ("this card", "this item"). State what the change does and the
shape of the work, nothing more. 1 short sentence, < 140 chars.

Output ONLY the sentence. If the inputs are too thin, output an empty string.`;

function commentaryUserPrompt(item: {
  title: string;
  status: string;
  kind: string | null;
  body: string;
}): string {
  return `\
Title: ${item.title}
Status: ${item.status}
Kind: ${item.kind ?? "(none)"}
Body:
${item.body.slice(0, 600) || "(empty)"}

Write the one-line context blurb.`;
}

// ---------------------------------------------------------------------------
// Hidden statuses — items here are excluded from output (Done belongs in the log)
// ---------------------------------------------------------------------------

const HIDDEN_STATUSES = new Set(["done", "closed", "shipped", "archived"]);

// ---------------------------------------------------------------------------
// Field extraction helpers (mirrors Python _extract_fields / _pick)
// ---------------------------------------------------------------------------

interface FieldValueNode {
  __typename: string;
  name?: string;
  text?: string;
  number?: number;
  date?: string;
  field?: { name?: string };
}

function extractFields(fieldValues: { nodes?: FieldValueNode[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const fv of fieldValues?.nodes ?? []) {
    const fieldName = fv.field?.name;
    if (!fieldName) continue;
    const t = fv.__typename;
    if (t === "ProjectV2ItemFieldSingleSelectValue" && fv.name) {
      out[fieldName] = fv.name;
    } else if (t === "ProjectV2ItemFieldTextValue" && fv.text) {
      out[fieldName] = fv.text;
    } else if (t === "ProjectV2ItemFieldNumberValue" && fv.number != null) {
      out[fieldName] = String(fv.number);
    } else if (t === "ProjectV2ItemFieldDateValue" && fv.date) {
      out[fieldName] = fv.date;
    }
  }
  return out;
}

/** Case-insensitive pick from field map, trying multiple alternate names. */
function pick(fields: Record<string, string>, ...names: string[]): string | null {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    lower[k.toLowerCase()] = v;
  }
  for (const n of names) {
    const v = lower[n.toLowerCase()];
    if (v != null) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// GraphQL response shape
// ---------------------------------------------------------------------------

interface ProjectItemNode {
  id: string;
  updatedAt: string;
  type: string;
  content: {
    __typename: string;
    number?: number;
    title?: string;
    body?: string;
    url?: string;
    state?: string;
    repository?: { nameWithOwner: string };
  } | null;
  fieldValues: { nodes?: FieldValueNode[] };
}

interface ProjectsV2Response {
  user: {
    projectV2: {
      id: string;
      title: string;
      number: number;
      url: string;
      items: { nodes: ProjectItemNode[] };
    } | null;
  };
}

// ---------------------------------------------------------------------------
// Sort helper — mirrors Python status priority grouping
// ---------------------------------------------------------------------------

const STATUS_ORDER = ["in progress", "blocked", "todo", "backlog", "untriaged"];
const STATUS_RANK: Record<string, number> = {};
STATUS_ORDER.forEach((s, i) => { STATUS_RANK[s] = i; });

function sortRoadmap(entries: RoadmapEntry[]): RoadmapEntry[] {
  return entries.sort((a, b) => {
    const rankA = STATUS_RANK[(a.status || "").toLowerCase()] ?? 99;
    const rankB = STATUS_RANK[(b.status || "").toLowerCase()] ?? 99;
    if (rankA !== rankB) return rankA - rankB;
    // Secondary sort: updatedAt ascending (matches Python reverse=False)
    return a.updatedAt.localeCompare(b.updatedAt);
  });
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runRoadmapSync(
  env: RoadmapSyncEnv,
): Promise<RoadmapSyncSummary> {
  const summary: RoadmapSyncSummary = {
    fetched: 0,
    kept: 0,
    hiddenDone: 0,
    commentaryNew: 0,
    commentaryCached: 0,
  };

  const projectNumber = env.GITHUB_PROJECT_NUMBER
    ? parseInt(env.GITHUB_PROJECT_NUMBER, 10)
    : null;

  if (!projectNumber) {
    // No project configured — clear roadmap just like Python does.
    await putSitePart(env.DB, "roadmap", []);
    summary.error = "GITHUB_PROJECT_NUMBER not set; cleared roadmap";
    return summary;
  }

  // Fetch Projects v2 items via GraphQL using a classic PAT — GitHub Apps
  // cannot access user-owned Projects v2 (platform limitation).
  let items: ProjectItemNode[];
  try {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_PAT_PROJECTS}`,
        "Content-Type": "application/json",
        "User-Agent": "evergreenlabs-bot",
      },
      body: JSON.stringify({
        query: PROJECTS_V2_QUERY,
        variables: { login: env.GITHUB_USERNAME, number: projectNumber },
      }),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { data?: ProjectsV2Response; errors?: Array<{ message: string }> };
    if (body.errors?.length) {
      throw new Error(body.errors[0].message);
    }
    const project = body.data?.user?.projectV2;
    if (!project) {
      summary.error = `Project #${projectNumber} not found under user ${env.GITHUB_USERNAME}`;
      return summary;
    }
    items = project.items.nodes ?? [];
  } catch (err) {
    // Graceful failure — log and return, do not crash DailySync
    summary.error = `GraphQL fetch failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[roadmap_sync] ${summary.error}`);
    return summary;
  }

  summary.fetched = items.length;

  // Build cache from existing roadmap entries in D1. The cache key is
  // `id::updatedAt` — same composite as the Python version.
  const existingRoadmap =
    (await getSitePart<RoadmapEntry[]>(env.DB, "roadmap")) ?? [];
  const commentaryCache = new Map<string, string>();
  for (const entry of existingRoadmap) {
    if (entry.id && entry.updatedAt && entry.commentary) {
      commentaryCache.set(`${entry.id}::${entry.updatedAt}`, entry.commentary);
    }
  }

  const out: RoadmapEntry[] = [];

  for (const node of items) {
    const content = node.content ?? {} as Partial<NonNullable<ProjectItemNode["content"]>>;
    const fields = extractFields(node.fieldValues);
    const status = pick(fields, "Status", "State") ?? "Untriaged";

    if (HIDDEN_STATUSES.has(status.toLowerCase())) {
      summary.hiddenDone += 1;
      continue;
    }

    const isDraft = content.__typename === "DraftIssue";
    const title = content.title ?? "(untitled)";
    const body = (content.body ?? "").trim();
    const url = content.url ?? null;
    const repo = content.repository?.nameWithOwner ?? null;
    const priority = pick(fields, "Priority");
    const kind = pick(fields, "Type", "Kind", "Category");
    // Normalize updatedAt to UTC ISO string (replace trailing Z with +00:00
    // for consistency with the Python output format)
    const updatedAt = node.updatedAt.replace("Z", "+00:00");

    // Commentary caching
    const cacheKey = `${node.id}::${updatedAt}`;
    let commentary = "";
    const cached = commentaryCache.get(cacheKey);
    if (cached != null) {
      commentary = cached;
      summary.commentaryCached += 1;
    } else {
      // Draft new commentary via LLM
      try {
        const result = await chat(env, COMMENTARY_SYSTEM, commentaryUserPrompt({
          title,
          status,
          kind,
          body,
        }), { temperature: 0.3, maxTokens: 160 });
        commentary = result.text.trim()
          .replace(/^```(?:html)?\s*\n?/i, "").replace(/\n?```\s*$/i, "")
          .replace(/^"|"$/g, "").trim();
      } catch (err) {
        console.error(`[roadmap_sync] commentary failed for ${node.id}: ${err}`);
        commentary = "";
      }
      summary.commentaryNew += 1;
    }

    out.push({
      id: node.id,
      title,
      status,
      priority,
      kind,
      url,
      repo,
      isDraft,
      commentary,
      updatedAt,
    });
  }

  const sorted = sortRoadmap(out);
  await putSitePart(env.DB, "roadmap", sorted);
  summary.kept = sorted.length;

  return summary;
}
