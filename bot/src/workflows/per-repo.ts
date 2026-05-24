// Per-repo, singleton-instance Workflow. Triggered by webhook intake in
// src/index.ts via env.PER_REPO_UPDATE.create({ id: <sanitized-repo-name> }).
//
// Slice 1: hollow tracer — one step writes a `tracer` row to D1 + publishes
// `_tracer` into siteData.js. Slice 2 replaces this with log_drafter +
// introduce + publish.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { putSitePart } from "../lib/state";
import { publishSiteData } from "../lib/publish";

export interface PerRepoEnv {
  DB: D1Database;
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  WEBSITE_REPO_OWNER: string;
  WEBSITE_REPO_NAME: string;
  SITE_DATA_PATH: string;
}

export interface PerRepoParams {
  repo?: string;
  delivery_id?: string;
  event?: string;
}

export class PerRepoUpdate extends WorkflowEntrypoint<PerRepoEnv, PerRepoParams> {
  async run(event: WorkflowEvent<PerRepoParams>, step: WorkflowStep): Promise<void> {
    await step.do("tracer", async () => {
      const payload = {
        lastTracerRun: new Date().toISOString(),
        kind: "per-repo",
        repo: event.payload?.repo ?? null,
        delivery_id: event.payload?.delivery_id ?? null,
      };
      await putSitePart(this.env.DB, "tracer", payload);
      await publishSiteData(this.env, { _tracer: payload }, "per-repo");
    });
  }
}
