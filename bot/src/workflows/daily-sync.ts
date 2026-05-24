// Daily sync Workflow. Triggered both by cron (`0 3 * * *`) and manually via
// POST /trigger/daily-sync. Slice 3 fills in the body: deterministic
// `project_sync` followed by a `publish` step that PUTs siteData.js. Future
// slices append roadmap_sync, introduce backstop, now_updater into this same
// step chain.
//
// Each meaningful unit of work runs inside its own `step.do` so the Workflow's
// per-step retry semantics apply (network blips during the GitHub repo list
// fetch or the Contents PUT don't tank the whole run). Inter-step state is
// kept small (just the summary counters) by writing the projects[] back to
// D1 in step 1 and re-reading it from D1 in step 2 — Workflow step return
// values must be JSON-serializable and there's no reason to round-trip the
// full projects[] through the engine when D1 already has it.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runProjectSync, type ProjectEntry, type ProjectSyncSummary } from "../pipelines/project_sync";
import { publishSiteData } from "../lib/publish";
import { getSitePart } from "../lib/state";

export interface DailySyncEnv {
  DB: D1Database;
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_USERNAME: string;
  WEBSITE_REPO_OWNER: string;
  WEBSITE_REPO_NAME: string;
  SITE_DATA_PATH: string;
}

export interface DailySyncParams {
  source?: "cron" | "manual";
}

export class DailySync extends WorkflowEntrypoint<DailySyncEnv, DailySyncParams> {
  async run(_event: WorkflowEvent<DailySyncParams>, step: WorkflowStep): Promise<void> {
    // Step 1: refresh siteData.projects metadata from the live GitHub repo
    // list. Pure D1 + GH API; no LLM. Writes site_parts.projects as a
    // side-effect and returns only the summary counters (small + cheap to
    // round-trip through the Workflow engine).
    await step.do("project_sync", async (): Promise<ProjectSyncSummary> => {
      const { summary } = await runProjectSync(this.env);
      return summary;
    });

    // Step 2: PUT the merged siteData.js to the website repo. Reads the
    // freshly-written projects[] back from D1 so this step is self-contained
    // and retries cleanly. Idempotent — publishSiteData returns early if the
    // rendered file is byte-identical to what's already on the default branch.
    await step.do("publish", async () => {
      const projects = (await getSitePart<ProjectEntry[]>(this.env.DB, "projects")) ?? [];
      await publishSiteData(this.env, { projects }, "daily-sync");
    });
  }
}
