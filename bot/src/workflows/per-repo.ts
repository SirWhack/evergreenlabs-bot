// Per-repo update Workflow. One instance per webhook delivery (unique id),
// triggered by src/index.ts after the raw event is enqueued in pending_events.
//
// Why not a deterministic per-repo singleton id? Cloudflare Workflows refuse
// to reuse instance ids within the retention window (days), so a singleton id
// would self-immolate after one push. Instead, every delivery gets its own
// instance; debounce + coalescing live in the shared pending_events queue:
//
//   1. Sleep DEBOUNCE_SECONDS so a burst of pushes lands in pending_events
//      before any instance starts draining.
//   2. Drain pending_events for this repo. First instance to drain wins;
//      slower instances find an empty queue and exit cheaply (a few KB of
//      Workflow state, no LLM cost).
//   3. For each unique commit SHA: fetch detail via GH API (need
//      additions/deletions for the judge prompt).
//   4. Run log_drafter (judge + draft).
//   5. Persist every result to D1 `drafts`. Sanity-bar passes get status
//      'accepted' and are spliced onto site_parts.log; fumbles get
//      'held_for_review' and stay out of the published siteData.js.
//   6. Update cursors.repo, pipeline='log_drafter' to the latest processed SHA.
//   7. Publish the updated log to the website repo via Contents API.
//
// Each numbered phase is its own step.do so Workflow retries are scoped.

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import { fetchCommitDetail, type CommitDetail, type GhAppEnv } from "../lib/github";
import { publishSiteData } from "../lib/publish";
import {
  drainPendingEvents,
  getSitePart,
  insertDraft,
  putSitePart,
  setCursor,
  type PendingEvent,
} from "../lib/state";
import { draftLogEntries, type LogDraft } from "../pipelines/log_drafter";
import { introduceRepo } from "../pipelines/introduce";
import { updateNow } from "../pipelines/now_updater";

const DEBOUNCE_SECONDS = 30;
const LOG_DRAFTER_PIPELINE = "log_drafter";

export interface PerRepoEnv extends GhAppEnv {
  DB: D1Database;
  PER_REPO_UPDATE: Workflow;
  // publish.ts needs these
  WEBSITE_REPO_OWNER: string;
  WEBSITE_REPO_NAME: string;
  SITE_DATA_PATH: string;
  // llm.ts needs these
  OPENROUTER_API_KEY: string;
  LLM_MODEL?: string;
  // Slice 5: introduce needs GITHUB_USERNAME to list repos
  GITHUB_USERNAME: string;
}

export interface PerRepoParams {
  repo?: string; // full_name, e.g. "SirWhack/foo"
  delivery_id?: string;
  event?: string;
}

interface DrainedCommit {
  sha: string;
  repoFullName: string;
  repoShortName: string;
}

export class PerRepoUpdate extends WorkflowEntrypoint<PerRepoEnv, PerRepoParams> {
  async run(
    event: WorkflowEvent<PerRepoParams>,
    step: WorkflowStep,
  ): Promise<void> {
    const repoFullName = event.payload?.repo;
    if (!repoFullName) {
      // Nothing actionable. Workflow exits cleanly so the singleton slot frees.
      return;
    }
    const repoShortName = shortName(repoFullName);

    // Phase 1 — debounce. Subsequent webhooks for this repo land in
    // pending_events while we sleep here. Re-create attempts at the Worker
    // hit "already exists" and noop, which is the entire coalescing trick.
    await step.sleep("debounce", `${DEBOUNCE_SECONDS} seconds`);

    // Phase 2 — drain. The triggering delivery is also in pending_events
    // (the Worker enqueues *before* attempting create), so we always have
    // at least one row to work with for first-instance kicks.
    //
    // We collapse drain + commit-extraction into one step so the step's
    // serialized return value is the concrete DrainedCommit[] (the
    // PendingEvent.payload field is `unknown` and not serializable across
    // step boundaries on its own).
    const drainResult = await step.do("drain-pending", async () => {
      const events = await drainPendingEvents(this.env.DB, repoFullName);
      const hasRepositoryCreated = events.some(
        (ev) => ev.event === "repository" && (ev.payload as any)?.action === "created",
      );
      const commits = extractUniqueCommits(events, repoFullName, repoShortName);
      return { commits, hasRepositoryCreated };
    });

    const { commits, hasRepositoryCreated } = drainResult;

    // --- Slice 5: introduce step for repository.created events ---
    // Runs BEFORE log_drafter so the new project card exists before any log
    // entries reference it. Only fires when a repository.created event was
    // in the drained batch.
    if (hasRepositoryCreated) {
      await step.do("introduce", async () => {
        const result = await introduceRepo(this.env, repoFullName);
        if (result?.accepted) {
          // Publish the updated projects to the site immediately
          await publishSiteData(this.env, {
            projects: (await getSitePart(this.env.DB, "projects")) ?? [],
          }, "introduce");
        }
        return result;
      });
    }

    if (commits.length === 0) {
      // Nothing to draft — could be a non-push event or a push with zero
      // commits[]. Exit cleanly.
      return;
    }

    // Phase 3 — fetch per-commit detail (stats + files) in parallel.
    const commitDetails = await step.do("fetch-commits", async () => {
      const out: CommitDetail[] = [];
      // Sequential to avoid spiking the GH API on a coalesced burst; commits
      // per drain are usually <10. If this becomes a bottleneck, parallelize.
      for (const c of commits) {
        try {
          const detail = await fetchCommitDetail(
            this.env,
            c.repoFullName,
            c.repoShortName,
            c.sha,
          );
          out.push(detail);
        } catch (e) {
          // One bad SHA shouldn't poison the batch. Log via re-throw inside
          // the step boundary? — no, swallow and continue; the cursor
          // update at the end will move past it on next run.
          console.error("per-repo: fetchCommitDetail failed", c.sha, e);
        }
      }
      return out;
    });

    if (commitDetails.length === 0) {
      return;
    }

    // Phase 4 — judge + draft via LLM.
    const drafted = await step.do("draft-log-entries", async () => {
      const projects = (await getSitePart<Array<{ slug?: string }>>(
        this.env.DB,
        "projects",
      )) ?? [];
      return draftLogEntries(commitDetails, {
        env: this.env,
        projects,
      });
    });

    // Phase 5 — persist drafts + update site_parts.log for accepted ones.
    const accepted = await step.do("persist-drafts", async () => {
      const acceptedPayloads: Array<LogDraft["payload"]> = [];
      for (const d of drafted.drafts) {
        const status = d.passesSanity ? "accepted" : "held_for_review";
        await insertDraft(this.env.DB, {
          id: crypto.randomUUID(),
          kind: "log_entry",
          payload: d.payload,
          source_repo: d.source_repo,
          source_commits: d.source_commits,
          status,
          notes: d.notes,
        });
        if (d.passesSanity) acceptedPayloads.push(d.payload);
      }
      if (acceptedPayloads.length > 0) {
        const currentLog =
          (await getSitePart<LogDraft["payload"][]>(this.env.DB, "log")) ?? [];
        // Newest first; preserves the autorun._apply order.
        const merged = [...acceptedPayloads.reverse(), ...currentLog];
        await putSitePart(this.env.DB, "log", merged);
      }
      return acceptedPayloads;
    });

    // Phase 6 — advance cursor to the latest commit we judged, regardless of
    // accept/skip. Order in commitDetails matches push order; last is newest.
    const latestSha = commitDetails[commitDetails.length - 1]?.sha;
    if (latestSha) {
      await step.do("advance-cursor", async () => {
        await setCursor(this.env.DB, repoShortName, LOG_DRAFTER_PIPELINE, latestSha);
      });
    }

    // Phase 7 — now_updater: refresh the "now" text when log entries were
    // accepted. Runs before publish so site_parts.now is up-to-date when the
    // single publish step fires. On fumble (text < 10 chars), a
    // held_for_review draft is inserted and site_parts.now is left untouched.
    // (Slice 6 — #9)
    if (accepted.length > 0) {
      await step.do("now-updater", async () => {
        await updateNow(this.env);
      });
    }

    // Phase 8 — publish if anything was accepted. Held-for-review drafts
    // sit in D1 and do NOT touch the live site. Publishes all of site_parts
    // that have been mutated (log + now) in a single Contents API PUT.
    if (accepted.length > 0) {
      await step.do("publish", async () => {
        const log = (await getSitePart<unknown>(this.env.DB, "log")) ?? [];
        const now = (await getSitePart<unknown>(this.env.DB, "now")) ?? {};
        await publishSiteData(this.env, { log, now }, "log_drafter+now_updater");
      });
    }
  }
}

function shortName(full: string): string {
  const slash = full.indexOf("/");
  return slash < 0 ? full : full.slice(slash + 1);
}

/**
 * Walk drained pending events, pull push payloads' commits[] arrays out,
 * and return a unique-by-SHA list in original push order. Non-push events
 * (create, repository, etc.) are silently ignored — Slice 2 only handles
 * log_drafter; future slices will inspect `event` here for introduce, etc.
 */
function extractUniqueCommits(
  pendingEvents: PendingEvent[],
  repoFullName: string,
  repoShortName: string,
): DrainedCommit[] {
  const seen = new Set<string>();
  const out: DrainedCommit[] = [];
  for (const ev of pendingEvents) {
    if (ev.event !== "push") continue;
    const payload = ev.payload as { commits?: Array<{ id?: string }> } | null | undefined;
    const commits = payload?.commits ?? [];
    for (const c of commits) {
      const sha = c?.id;
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);
      out.push({ sha, repoFullName, repoShortName });
    }
  }
  return out;
}
