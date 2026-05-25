// log_drafter — port of src/evergreenlabs_bot/pipelines/log_drafter.py.
//
// Walks a set of commits (drained from pending_events for the per-repo
// Workflow trigger, or fetched against `cursors` for a missed-webhook
// backstop), classifies each via _judge (logworthy?), drafts prose bodies
// for the keepers via _draft_body, and returns the drafts shaped for the
// `drafts` D1 table.
//
// Prompts are kept byte-identical to the Python original so site voice
// stays consistent across the migration. Sanity bar mirrors
// autorun._passes_sanity for kind="log_entry".
//
// Feedback-loop guard: skip commits authored by the GitHub App itself
// ([bot]@users.noreply.github.com). All repos are tracked — including
// evergreenlabs-bot (dogfooding) — but the bot's own chore publishes to the
// website repo must not trigger a new draft→publish→webhook loop.

import type { CommitDetail } from "../lib/github";
import { chat, chatJson, type LlmEnv } from "../lib/llm";
import { shortDate } from "../lib/site-conventions";

const JUDGE_SYSTEM = `You are filtering a developer's git commits for inclusion in a public dev log.
The log voice is terse, specific, often self-deprecating: it records what was
tried, what worked, what didn't, and the small lesson learned. Examples:
- "swapped the VLM fallback for a smaller open model. Faster and cheaper, but it
  loses small-caps as italics about a third of the time. Reverting."
- "Ported dmscreen's dice roller to WebAssembly to see if it'd be faster. It
  is not. Reverted in 20 minutes."

Logworthy commits change *behavior or approach* in a way a reader could form an
opinion about. NOT logworthy: typo fixes, formatting, dependency bumps, README
edits, merge commits, "wip" commits, vendored asset updates, generated files.
`;

const DRAFT_SYSTEM = `You write entries for a developer's public dev log. Voice rules:
- 1-3 short sentences. Specific over abstract.
- Lowercase commit-message-style; small inline <code>tags</code> for filenames or
  identifiers; occasional &ldquo;quote&rdquo; or &mdash;.
- Self-deprecation is fine. Avoid hype words ("excited", "powerful", "robust").
- Lead with the change; end with what it cost, what it taught, or what's next.

Output ONLY the HTML body — no surrounding tags, no leading "Today I…",
no explanations.
`;

export interface LogEntryPayload {
  date: string; // e.g. "may 24"
  year: string; // e.g. "2026"
  body: string;
  project: string | null;
}

export interface LogDraft {
  payload: LogEntryPayload;
  source_repo: string;
  source_commits: string[];
  /** Judge's reason ("logworthy" or "fumbled because ..."). */
  notes: string;
  /** Whether the draft passes the sanity bar (≥20 char body). */
  passesSanity: boolean;
  /** SHA processed — caller uses this to advance the cursors table. */
  sha: string;
}

export interface LogDrafterDeps {
  env: LlmEnv;
  /** Projects array from site_parts.projects, used for slug lookup. */
  projects: Array<{ slug?: string }>;
}

export interface LogDrafterResult {
  drafts: LogDraft[];
  judged: number;
  skipped: number;
  errored: number;
}

export function formatFiles(files: string[]): string {
  if (!files.length) return "(none)";
  if (files.length <= 6) return files.join(", ");
  return files.slice(0, 6).join(", ") + `, … (+${files.length - 6} more)`;
}

export function projectSlugForRepo(
  repoName: string,
  projects: Array<{ slug?: string }>,
): string | null {
  const rl = repoName.toLowerCase();
  for (const p of projects) {
    if (typeof p.slug === "string" && p.slug.toLowerCase() === rl) return p.slug;
  }
  return null;
}

/** Returns [logworthy, reason]. Returns false on judge error (fail closed). */
async function judge(
  env: LlmEnv,
  commit: CommitDetail,
): Promise<{ logworthy: boolean; reason: string }> {
  const user =
    `Repo: ${commit.repo}\n` +
    `Message: ${commit.message}\n` +
    `Files changed (${commit.filesChanged.length}): ${formatFiles(commit.filesChanged)}\n` +
    `Diff size: +${commit.additions}/-${commit.deletions}\n\n` +
    `Decide: is this commit logworthy?\n` +
    `Return JSON: {"logworthy": true|false, "reason": "<one short clause>"}\n`;
  try {
    const result = await chatJson<{ logworthy?: boolean; reason?: unknown }>(
      env,
      JUDGE_SYSTEM,
      user,
      { maxTokens: 120 },
    );
    return {
      logworthy: Boolean(result.logworthy),
      reason: typeof result.reason === "string" ? result.reason : "",
    };
  } catch (e: any) {
    return { logworthy: false, reason: `judge failed: ${e?.message ?? e}` };
  }
}

async function draftBody(
  env: LlmEnv,
  commit: CommitDetail,
  slug: string | null,
): Promise<string> {
  const user =
    `Project: ${commit.repo} (slug: ${slug ?? commit.repo})\n` +
    `Commit message: ${commit.message}\n` +
    `Files: ${formatFiles(commit.filesChanged)}\n` +
    `Diff: +${commit.additions}/-${commit.deletions}\n\n` +
    `Write a log entry body (HTML allowed: <code>, <b>, <i>, <a>).\n`;
  const result = await chat(env, DRAFT_SYSTEM, user, {
    temperature: 0.5,
    maxTokens: 300,
  });
  return result.text;
}

/**
 * Mirrors autorun._passes_sanity for kind="log_entry". A body shorter than
 * 20 chars is almost always a truncated or refused generation; hold those
 * for human review rather than publishing fumbled prose to the site.
 */
export function passesSanity(payload: LogEntryPayload): { ok: boolean; reason: string } {
  const body = (payload.body ?? "").trim();
  if (body.length < 20) return { ok: false, reason: `body too short (${body.length} chars)` };
  return { ok: true, reason: "" };
}

/**
 * Judge + draft a batch of commits. Caller is responsible for fetching
 * commit detail (see lib/github.fetchCommitDetail) and deduping commits
 * across coalesced webhook events.
 */
export async function draftLogEntries(
  commits: CommitDetail[],
  deps: LogDrafterDeps,
): Promise<LogDrafterResult> {
  const out: LogDraft[] = [];
  let judged = 0;
  let skipped = 0;
  let errored = 0;

  for (const commit of commits) {
    // Feedback-loop guard: skip commits authored by the bot's GitHub App.
    if (commit.authorEmail?.includes("[bot]@users.noreply.github.com")) {
      skipped += 1;
      continue;
    }

    judged += 1;
    const { logworthy, reason } = await judge(deps.env, commit);
    if (!logworthy) {
      skipped += 1;
      continue;
    }

    const slug = projectSlugForRepo(commit.repo, deps.projects);
    let body: string;
    try {
      body = await draftBody(deps.env, commit, slug);
    } catch (e: any) {
      errored += 1;
      // Build a held-for-review draft anyway so the operator can see what
      // failed instead of silently dropping a logworthy commit.
      body = `(draft failed: ${e?.message ?? e})`;
    }

    const { date, year } = shortDate(commit.date);
    const payload: LogEntryPayload = { date, year, body, project: slug };
    const { ok } = passesSanity(payload);

    out.push({
      payload,
      source_repo: commit.repo,
      source_commits: [commit.sha],
      notes: reason,
      passesSanity: ok,
      sha: commit.sha,
    });
  }

  return { drafts: out, judged, skipped, errored };
}

// Re-export so workflows/per-repo.ts can pull a single named export from this
// file without also reaching into lib/github for the type.
export type { CommitDetail } from "../lib/github";
