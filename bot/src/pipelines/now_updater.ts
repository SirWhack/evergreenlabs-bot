// now_updater — port of src/evergreenlabs_bot/pipelines/now_updater.py.
//
// Called within the PerRepoUpdate Workflow after log_drafter produces accepted
// entries. Reads the most recent accepted log entries from site_parts.log,
// drafts a new "now" text via LLM, and writes back to site_parts.now.
//
// Prompts ported verbatim from the Python original. Sanity bar: text >= 10
// chars trimmed. Fumbled drafts (too short) are held_for_review and do NOT
// overwrite site_parts.now.

import { chat, type LlmEnv } from "../lib/llm";
import { getSitePart, insertDraft, putSitePart } from "../lib/state";

// ---------------------------------------------------------------------------
// Prompts — verbatim from Python now_updater.py
// ---------------------------------------------------------------------------

const SYSTEM = `You are drafting a one-line "what I'm working on this week" status for a
developer's public site. Voice: terse, specific, present-tense, lowercase.
Mentions a project by name with <b>bold</b>. Optionally adds one sentence about
the current obstacle. No hype words. 1-2 sentences total, < 240 chars.

Output only the HTML body. No prose around it.`;

const LOG_USER_TEMPLATE = `The user just accepted a log entry. Forward-rephrase it as a "currently
working on" status — same project, present tense, looking ahead at the next
step. Do NOT quote the log entry verbatim.

Project: {project_title}
Project blurb: {blurb}
Log entry body: {body}

Write the now.text body.`;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NowPayload {
  weekOf: string; // e.g. "may 24"
  text: string;
}

interface LogEntry {
  body?: string;
  project?: string | null;
  date?: string;
  year?: string;
}

interface ProjectEntry {
  slug?: string;
  title?: string;
  blurb?: string;
}

export interface NowUpdaterEnv extends LlmEnv {
  DB: D1Database;
}

export interface NowUpdaterResult {
  status: "accepted" | "fumbled";
  payload: NowPayload;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

/** Format current UTC date as "mon dd" lowercase — e.g. "may 24". */
function currentWeekOf(): string {
  const now = new Date();
  const month = MONTHS[now.getUTCMonth()];
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${month} ${day}`;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

/**
 * Draft a new "now" text based on the most recent accepted log entries.
 *
 * Returns the result with status "accepted" (wrote to site_parts.now) or
 * "fumbled" (held_for_review draft inserted, site_parts.now NOT touched).
 * Returns null if there's nothing to work with (no log entries, no project).
 */
export async function updateNow(env: NowUpdaterEnv): Promise<NowUpdaterResult | null> {
  // Read top 5 entries from site_parts.log
  const log = (await getSitePart<LogEntry[]>(env.DB, "log")) ?? [];
  if (log.length === 0) return null;

  const topEntries = log.slice(0, 5);

  // Use the most recent entry as the primary signal
  const latest = topEntries[0];
  const slug = latest.project;
  if (!slug) return null;

  // Look up project title and blurb
  const projects = (await getSitePart<ProjectEntry[]>(env.DB, "projects")) ?? [];
  const project = projects.find(
    (p) => typeof p.slug === "string" && p.slug.toLowerCase() === slug.toLowerCase(),
  );
  const title = project?.title ?? slug;
  const blurb = project?.blurb ?? "";

  // LLM call — temperature 0.5, max 200 tokens (matching Python original)
  let text: string;
  try {
    const result = await chat(env, SYSTEM, LOG_USER_TEMPLATE
      .replace("{project_title}", title)
      .replace("{blurb}", blurb || "(none)")
      .replace("{body}", latest.body ?? ""), {
      temperature: 0.5,
      maxTokens: 200,
    });
    text = result.text.trim();
    // Strip markdown code fences if the model wraps the output
    text = text.replace(/^```(?:html)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  } catch (e: any) {
    // LLM failure — cannot draft. Bail out silently rather than crashing
    // the Workflow. Operator sees it in console logs.
    console.error("now_updater: LLM call failed", e?.message ?? e);
    return null;
  }

  const weekOf = currentWeekOf();
  const payload: NowPayload = { weekOf, text };

  // Sanity bar: text >= 10 chars trimmed
  const passes = text.length >= 10;
  const status = passes ? "accepted" : "held_for_review";

  // Write draft to D1
  await insertDraft(env.DB, {
    id: crypto.randomUUID(),
    kind: "now_text",
    payload,
    source_repo: slug,
    source_commits: [],
    status,
    notes: passes
      ? `derived from latest log entry: ${latest.date ?? ""} ${latest.year ?? ""}`
      : `fumbled: text too short (${text.length} chars)`,
  });

  // Only update site_parts.now if it passes sanity
  if (passes) {
    await putSitePart(env.DB, "now", payload);
    return { status: "accepted", payload };
  }

  return { status: "fumbled", payload };
}
