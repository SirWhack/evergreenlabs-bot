// introduce — drafts project cards for new repos on the site.
// Port of src/evergreenlabs_bot/pipelines/introduce.py per ADR-0001.
//
// Two entry points:
//   1. introduceRepo(env, repoFullName) — webhook path (repository.created)
//   2. introduceOrphans(env) — daily-sync backstop (catches repos that
//      existed before the App was installed or that webhooks missed)
//
// Draft shape: kind='project_intro', payload is a ProjectEntry.
// Sanity bar: non-empty blurb. Fumbled → insert into skipped_repos.

import { fetchReadme, listPublicRepos, type GhAppEnv, type GhRepo } from "../lib/github";
import { chat, type LlmEnv } from "../lib/llm";
import {
  getSitePart,
  insertDraft,
  insertSkippedRepo,
  isSkipped,
  putSitePart,
} from "../lib/state";
import type { ProjectEntry } from "./project_sync";

/** Repos hardcoded to skip — matches Python `SKIP_NAMES`. */
const SKIP_NAMES = new Set<string>(["evergreenlabs"]);

// ---------------------------------------------------------------------------
// Prompts — ported verbatim from Python introduce.py
// ---------------------------------------------------------------------------

const BLURB_SYSTEM = `\
You write one-sentence project blurbs for a developer's personal site.
Voice: lowercase, terse, specific. Mentions what the project does, not why.
No hype words (powerful, robust, excited). No first-person.

Examples of the voice:
- "Extracts structured markdown from academic and legal PDFs. Multi-column reading order, tables, footnotes, citations."
- "A single-page DM screen for D&D 5e — initiative, conditions, concentration, monster lookup. Works offline."

Output ONLY the blurb. No quotes, no prose around it.
If the inputs are too thin to write something honest, output an empty string.`;

const BLURB_USER_TEMPLATE = `\
Repo: {name}
Language: {language}
Topics: {topics}
GitHub description: {description}

README (first ~400 chars):
{readme}

Write the blurb (1-2 short sentences, or empty if you don't have enough).`;

// ---------------------------------------------------------------------------
// Env shape needed by this pipeline
// ---------------------------------------------------------------------------

export interface IntroduceEnv extends GhAppEnv, LlmEnv {
  DB: D1Database;
  GITHUB_USERNAME: string;
}

// ---------------------------------------------------------------------------
// Helpers — ported from Python
// ---------------------------------------------------------------------------

/** Kebab-case slug from a repo name. Mirrors Python `_sluggify`. */
function sluggify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "project";
}

/** Trim a README to the first ~400 prose characters, stripping headings/images. */
function readmeExcerpt(text: string | null, n = 400): string {
  if (!text) return "(no README)";
  const lines = text
    .split("\n")
    .filter((ln) => {
      const trimmed = ln.trim();
      return trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("![") && !trimmed.startsWith("<!--");
    });
  const body = lines.join(" ");
  return body.length > n ? body.slice(0, n) + "…" : body;
}

/** First 4 topics uppercased, dashes to spaces. Falls back to language. */
function normalizeTags(repo: GhRepo): string[] {
  const out = repo.topics.slice(0, 4).map((t) => t.toUpperCase().replace(/-/g, " "));
  if (out.length === 0 && repo.language) {
    return [repo.language.toUpperCase()];
  }
  return out;
}

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

/** "updated <mon> <year>" lowercase. */
function metaString(pushedAtIso: string): string {
  const d = new Date(pushedAtIso);
  const month = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return `updated ${month} ${year}`;
}

/** Call the LLM to draft a blurb. Returns empty string on failure. */
async function draftBlurb(
  env: LlmEnv,
  repo: GhRepo,
  readme: string | null,
): Promise<string> {
  const user = BLURB_USER_TEMPLATE
    .replace("{name}", repo.name)
    .replace("{language}", repo.language || "(unknown)")
    .replace("{topics}", repo.topics.join(", ") || "(none)")
    .replace("{description}", repo.description || "(none)")
    .replace("{readme}", readmeExcerpt(readme));
  try {
    const result = await chat(env, BLURB_SYSTEM, user, {
      temperature: 0.4,
      maxTokens: 200,
    });
    // Strip surrounding quotes the model sometimes adds
    return result.text.trim()
      .replace(/^```(?:html)?\s*\n?/i, "").replace(/\n?```\s*$/i, "")
      .replace(/^"+|"+$/g, "").trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface IntroduceResult {
  slug: string;
  accepted: boolean;
}

/**
 * Introduce a single repo. Called from the webhook path on `repository.created`.
 * Returns the result (accepted/skipped) or null if the repo was already known
 * or should be skipped (archived, fork, etc.).
 */
export async function introduceRepo(
  env: IntroduceEnv,
  repoFullName: string,
): Promise<IntroduceResult | null> {
  const repoShortName = repoFullName.includes("/")
    ? repoFullName.slice(repoFullName.indexOf("/") + 1)
    : repoFullName;

  // Fetch repo metadata to check archived/fork/skip-list
  const repos = await listPublicRepos(env, env.GITHUB_USERNAME);
  const repo = repos.find((r) => r.full_name === repoFullName);
  if (!repo) return null;
  if (repo.archived || repo.fork || SKIP_NAMES.has(repo.name)) return null;

  const slug = sluggify(repo.name);

  // Already introduced?
  const existing = (await getSitePart<ProjectEntry[]>(env.DB, "projects")) ?? [];
  const knownSlugs = new Set(existing.map((p) => p.slug?.toLowerCase()));
  if (knownSlugs.has(slug)) return null;

  // Already skipped?
  if (await isSkipped(env.DB, repo.name)) return null;

  return introduceOne(env, repo, existing);
}

/**
 * Backstop: iterate all public repos, find orphans (not in projects, not
 * skipped), and introduce them. Called from daily-sync after project_sync.
 */
export async function introduceOrphans(
  env: IntroduceEnv,
): Promise<{ scanned: number; introduced: number; skipped: number }> {
  const summary = { scanned: 0, introduced: 0, skipped: 0 };
  const repos = await listPublicRepos(env, env.GITHUB_USERNAME);
  // Re-read projects fresh each iteration to see newly-added entries
  let existing = (await getSitePart<ProjectEntry[]>(env.DB, "projects")) ?? [];

  for (const repo of repos) {
    if (repo.archived || repo.fork || SKIP_NAMES.has(repo.name)) continue;
    summary.scanned += 1;

    const slug = sluggify(repo.name);
    const knownSlugs = new Set(existing.map((p) => p.slug?.toLowerCase()));
    if (knownSlugs.has(slug)) continue;
    if (await isSkipped(env.DB, repo.name)) continue;

    const result = await introduceOne(env, repo, existing);
    if (result?.accepted) {
      summary.introduced += 1;
      // Re-read so subsequent iterations see the new entry
      existing = (await getSitePart<ProjectEntry[]>(env.DB, "projects")) ?? [];
    } else {
      summary.skipped += 1;
    }
  }
  return summary;
}

/**
 * Core logic: fetch README, draft blurb, persist draft + update site_parts.
 * Shared between webhook path and backstop path.
 */
async function introduceOne(
  env: IntroduceEnv,
  repo: GhRepo,
  existing: ProjectEntry[],
): Promise<IntroduceResult> {
  const slug = sluggify(repo.name);
  const nextIdx = Math.max(0, ...existing.map((p) => p.idx ?? 0)) + 1;

  const readme = await fetchReadme(env, repo.full_name);
  const blurb = await draftBlurb(env, repo, readme);

  const payload: ProjectEntry = {
    idx: nextIdx,
    slug,
    title: repo.name,
    blurb,
    longBlurb: "",
    writeup: "",
    tags: normalizeTags(repo),
    meta: metaString(repo.pushed_at),
    stack: repo.language || "",
    status: "active",
    featured: false,
    screenshot: "",
    links: { repo: repo.html_url, demo: "", writeup: "" },
  };

  // Sanity bar: non-empty blurb
  const passesSanity = blurb.trim().length > 0;

  if (!passesSanity) {
    // Fumbled — add to skipped_repos so we don't retry
    await insertSkippedRepo(env.DB, repo.name, "autorun: empty blurb");
    return { slug, accepted: false };
  }

  // Persist draft as accepted
  await insertDraft(env.DB, {
    id: crypto.randomUUID(),
    kind: "project_intro",
    payload,
    source_repo: repo.name,
    source_commits: [],
    status: "accepted",
    notes: repo.description || "",
  });

  // Append to site_parts.projects
  const current = (await getSitePart<ProjectEntry[]>(env.DB, "projects")) ?? [];
  current.push(payload);
  await putSitePart(env.DB, "projects", current);

  return { slug, accepted: true };
}
