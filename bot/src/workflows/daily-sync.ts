// Daily sync Workflow. Triggered both by cron (`0 3 * * *`) and manually via
// POST /trigger/daily-sync. Steps: project_sync → introduce backstop →
// issue_sync (cross-repo board mirror) → roadmap_sync → publish.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runProjectSync, type ProjectEntry, type ProjectSyncSummary } from "../pipelines/project_sync";
import { introduceOrphans } from "../pipelines/introduce";
import { runIssueSync, type IssueSyncSummary } from "../pipelines/issue_sync";
import { runRoadmapSync, type RoadmapEntry, type RoadmapSyncSummary } from "../pipelines/roadmap_sync";
import { publishSiteData } from "../lib/publish";
import { getSitePart } from "../lib/state";

export interface DailySyncEnv {
  DB: D1Database;
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  GITHUB_USERNAME: string;
  GITHUB_PROJECT_OWNER: string;
  GITHUB_PROJECT_NUMBER?: string;
  GITHUB_PAT_PROJECTS: string;
  OPENROUTER_API_KEY: string;
  LLM_MODEL?: string;
  WEBSITE_REPO_OWNER: string;
  WEBSITE_REPO_NAME: string;
  SITE_DATA_PATH: string;
}

export interface DailySyncParams {
  source?: "cron" | "manual";
}

export class DailySync extends WorkflowEntrypoint<DailySyncEnv, DailySyncParams> {
  async run(_event: WorkflowEvent<DailySyncParams>, step: WorkflowStep): Promise<void> {
    await step.do("project_sync", async (): Promise<ProjectSyncSummary> => {
      const { summary } = await runProjectSync(this.env);
      return summary;
    });

    await step.do("introduce_backstop", async () => {
      return introduceOrphans(this.env);
    });

    // ADR-0003: mirror every repo's issues onto the board, catching anything
    // missed between webhook windows. Runs before roadmap_sync so the roadmap
    // reflects the freshly-reconciled board.
    await step.do("issue_sync", async (): Promise<IssueSyncSummary> => {
      return await runIssueSync(this.env);
    });

    await step.do("roadmap_sync", async (): Promise<RoadmapSyncSummary> => {
      return await runRoadmapSync(this.env);
    });

    await step.do("publish", async () => {
      const projects = (await getSitePart<ProjectEntry[]>(this.env.DB, "projects")) ?? [];
      const roadmap = (await getSitePart<RoadmapEntry[]>(this.env.DB, "roadmap")) ?? [];
      await publishSiteData(this.env, { projects, roadmap }, "daily-sync");
    });
  }
}
