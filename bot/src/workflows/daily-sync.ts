// Daily sync Workflow. Triggered both by cron (`0 3 * * *`) and manually via
// POST /trigger/daily-sync. Slice 1: hollow tracer — writes a `tracer` row
// to D1 and publishes `_tracer` into siteData.js. Slice 3 fills in
// roadmap_sync + project_sync + introduce backstop.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { putSitePart } from "../lib/state";
import { publishSiteData } from "../lib/publish";

export interface DailySyncEnv {
  DB: D1Database;
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  WEBSITE_REPO_OWNER: string;
  WEBSITE_REPO_NAME: string;
  SITE_DATA_PATH: string;
}

export interface DailySyncParams {
  source?: "cron" | "manual";
}

export class DailySync extends WorkflowEntrypoint<DailySyncEnv, DailySyncParams> {
  async run(event: WorkflowEvent<DailySyncParams>, step: WorkflowStep): Promise<void> {
    await step.do("tracer", async () => {
      const payload = {
        lastTracerRun: new Date().toISOString(),
        kind: "daily-sync",
        source: event.payload?.source ?? "cron",
      };
      await putSitePart(this.env.DB, "tracer", payload);
      await publishSiteData(this.env, { _tracer: payload }, "daily-sync");
    });
  }
}
