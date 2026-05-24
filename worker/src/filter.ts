import type { EventRecord } from "./store";

// Coarse filter — decides whether to enqueue at all. The bot does its own
// finer filtering (archived, forks, skip-list) before running.
export function shouldEnqueue(event: string, payload: any, expectedOwner: string): boolean {
  const ownerLogin = payload?.repository?.owner?.login;
  if (ownerLogin !== expectedOwner) return false;

  if (event === "push") {
    const ref: string = payload?.ref ?? "";
    const defaultBranch: string = payload?.repository?.default_branch ?? "";
    return defaultBranch !== "" && ref === `refs/heads/${defaultBranch}`;
  }
  if (event === "pull_request") {
    return payload?.action === "closed" && payload?.pull_request?.merged === true;
  }
  if (event === "create" || event === "delete") {
    return true;
  }
  return false;
}

export function extractRecord(event: string, payload: any, deliveryId: string): EventRecord {
  const ts = new Date().toISOString();
  const base: EventRecord = {
    delivery_id: deliveryId,
    event,
    action: payload?.action,
    ts,
  };
  base.repo = payload?.repository?.full_name;
  if (event === "push") {
    base.sha = payload?.after;
    base.branch = String(payload?.ref ?? "").replace(/^refs\/heads\//, "");
  } else if (event === "pull_request") {
    base.sha = payload?.pull_request?.merge_commit_sha;
    base.branch = payload?.pull_request?.base?.ref;
  } else if (event === "create" || event === "delete") {
    base.branch = payload?.ref;
  }
  return base;
}
