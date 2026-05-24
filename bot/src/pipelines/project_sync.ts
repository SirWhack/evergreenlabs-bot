// project_sync — deterministic, LLM-free metadata refresh for siteData.projects.
// Port of src/evergreenlabs_bot/pipelines/project_sync.py. Behavior preserved:
//   - Fetches the configured user's public repos via the GitHub REST API
//     (App-authenticated, paged, sorted by pushed).
//   - Skips archived repos, forks, and the hardcoded `evergreenlabs` site repo.
//   - Skips entries that aren't already in the existing projects[] (no auto-add;
//     that's `introduce`'s job).
//   - For each match, refreshes:
//       links.repo  (only if currently empty)
//       meta        (always — "updated <mon> <year>" lowercase)
//       tags        (replaces, if any topics — uppercased, dashes -> spaces, first 4)
//       stack       (only if currently empty, taken from primary language)
//       blurb       (only if currently empty)
//   - Preserves the hand-written fields (longBlurb, writeup, screenshot, status,
//     featured, idx, title, slug).
//   - Respects the `skipped_repos` D1 table for the unintroduced/skiplisted
//     accounting (does not affect output for matched entries).
//
// Output is written back to D1 `site_parts.projects` as a JSON array in the
// same key order produced by the Python pipeline. The caller (the daily-sync
// Workflow) is responsible for `publishSiteData({ projects }, ...)`.

import { listPublicRepos, type GhAppEnv, type GhRepo } from "../lib/github";
import { getSitePart, isSkipped, putSitePart } from "../lib/state";

/** Repos hardcoded to skip — matches Python `SKIP_NAMES`. */
const SKIP_NAMES = new Set<string>(["evergreenlabs"]);

/** Result counters mirroring the Python `summary` dict. */
export interface ProjectSyncSummary {
  scanned: number;
  matched: number;
  updated: number;
  unintroduced: number;
  skiplisted: number;
}

export interface ProjectLinks {
  repo?: string;
  demo?: string;
  writeup?: string;
  [k: string]: string | undefined;
}

/**
 * Project entry as it lives in `siteData.projects[]`. Optional/unknown extra
 * fields are preserved verbatim so the website renderer (and future ADRs)
 * can extend the shape without this port losing data.
 */
export interface ProjectEntry {
  slug: string;
  title?: string;
  blurb?: string;
  longBlurb?: string;
  writeup?: string;
  tags?: string[];
  meta?: string;
  stack?: string;
  status?: string;
  featured?: boolean;
  screenshot?: string;
  links?: ProjectLinks;
  idx?: number;
  [k: string]: unknown;
}

interface ProjectSyncEnv extends GhAppEnv {
  DB: D1Database;
  GITHUB_USERNAME: string;
}

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

/** "updated <mon> <year>" lowercase. Mirrors Python `_meta_string`. */
function metaString(pushedAtIso: string): string {
  const d = new Date(pushedAtIso);
  // Use UTC to match Python's tz-aware datetime (pushed_at is UTC).
  const month = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return `updated ${month} ${year}`;
}

/** First 4 topics, uppercased, dashes -> spaces. Mirrors Python `_normalize_topics`. */
function normalizeTopics(topics: readonly string[]): string[] {
  return topics.slice(0, 4).map((t) => t.toUpperCase().replace(/-/g, " "));
}

function shortBlurb(description: string | null): string {
  if (!description) return "";
  return description.trim();
}

/**
 * Cheap structural equality for project entries used by the `updated` counter.
 * Mirrors Python's `entry != before` after `before = dict(entry)`: a shallow
 * compare is insufficient because `links` is a nested dict, so we serialize.
 */
function entriesEqual(a: ProjectEntry, b: ProjectEntry): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Run the project_sync pipeline against the configured GitHub username.
 *
 * Reads `site_parts.projects` (defaulting to `[]` if missing), refreshes each
 * matched entry in place, writes the result back to `site_parts.projects`, and
 * returns the updated projects[] alongside summary counters. The returned
 * `projects` is what the caller should hand to `publishSiteData`.
 */
export async function runProjectSync(
  env: ProjectSyncEnv,
): Promise<{ projects: ProjectEntry[]; summary: ProjectSyncSummary }> {
  const existing = (await getSitePart<ProjectEntry[]>(env.DB, "projects")) ?? [];

  // Preserve original order (Python iterates by_slug.values() which is dict
  // insertion order = list order from load_site_part).
  const bySlug = new Map<string, ProjectEntry>();
  for (const p of existing) {
    if (p && typeof p.slug === "string") bySlug.set(p.slug, p);
  }

  const summary: ProjectSyncSummary = {
    scanned: 0,
    matched: 0,
    updated: 0,
    unintroduced: 0,
    skiplisted: 0,
  };

  const repos = await listPublicRepos(env, env.GITHUB_USERNAME);

  for (const repo of repos) {
    if (repo.archived || repo.fork || SKIP_NAMES.has(repo.name)) continue;
    summary.scanned += 1;
    const slug = repo.name.toLowerCase();
    const entry = bySlug.get(slug);
    if (!entry) {
      if (await isSkipped(env.DB, repo.name)) {
        summary.skiplisted += 1;
      } else {
        summary.unintroduced += 1;
      }
      continue;
    }

    summary.matched += 1;
    // JSON-clone snapshot for the change detector — mirrors Python `dict(entry)`
    // followed by `entry != before` after nested mutation of `links`.
    const before: ProjectEntry = JSON.parse(JSON.stringify(entry));

    applyRepoMetadata(entry, repo);

    if (!entriesEqual(entry, before)) {
      summary.updated += 1;
    }
  }

  const projects = Array.from(bySlug.values());
  await putSitePart(env.DB, "projects", projects);
  return { projects, summary };
}

/**
 * Mutate `entry` in place with metadata pulled from `repo`. Mirrors the
 * field-by-field rules in the Python `sync_projects` inner loop.
 *
 * Refresh policy:
 *   - links.repo  : write only if missing/empty
 *   - meta        : always overwrite
 *   - tags        : overwrite when repo has any topics; preserve otherwise
 *   - stack       : write only if missing/empty (taken from primary language)
 *   - blurb       : write only if missing/empty (taken from repo description)
 *
 * Hand-written fields (longBlurb, writeup, screenshot, status, featured, idx,
 * title) are untouched.
 */
function applyRepoMetadata(entry: ProjectEntry, repo: GhRepo): void {
  const links: ProjectLinks = entry.links ?? {};
  if (!links.repo) {
    links.repo = repo.html_url;
  }
  entry.links = links;

  entry.meta = metaString(repo.pushed_at);

  const topics = normalizeTopics(repo.topics);
  if (topics.length > 0) {
    entry.tags = topics;
  }

  const currentStack = typeof entry.stack === "string" ? entry.stack.trim() : "";
  if (repo.language && currentStack === "") {
    entry.stack = repo.language;
  }

  if (!entry.blurb) {
    entry.blurb = shortBlurb(repo.description);
  }
}
