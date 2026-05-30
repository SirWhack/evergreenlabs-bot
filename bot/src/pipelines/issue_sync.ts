// issue_sync — the cross-repo board reconciler (ADR-0003 §D2/D3/D5).
//
// Two-layer model: the board's Status single-select field is the source of
// truth for lifecycle; the GitHub issue's open/closed state is a projection
// of it, kept consistent in both directions.
//
//   Lean lifecycle:
//     OPEN issue   → Status "Todo" or "In Progress"
//     CLOSED issue → Status "Done"     (state_reason completed)
//                  → Status "Won't Do" (state_reason not_planned)
//
// Two reconcile directions, both idempotent so the open/close ↔ Status loop
// converges instead of oscillating:
//   - issue → board  (reconcileIssueToBoard): a webhook `issues` event or the
//     daily sweep observed an issue; ensure it's on the board and its Status
//     is consistent with open/closed. Only writes when inconsistent, so it
//     never clobbers a human's "In Progress" on an open issue.
//   - board → issue  (applyStatusToIssue): an agent set a Status via MCP;
//     move the issue's open/closed state to match (close with the right
//     reason, or reopen).

import {
  closeIssue,
  reopenIssue,
  listAllIssues,
  listPublicRepos,
  type GhAppEnv,
  type GhIssue,
  type IssueState,
  type IssueStateReason,
} from "../lib/github";
import {
  addItemByContentId,
  getItemRef,
  updateItemField,
  type BoardEnv,
} from "../mcp/board";
import { insertBoardEvent } from "../lib/state";

export const STATUS_FIELD = "Status";

export type BoardStatus = "Todo" | "In Progress" | "Done" | "Won't Do";

const OPEN_STATUSES = new Set(["todo", "in progress"]);

// ---------------------------------------------------------------------------
// Pure mapping helpers (unit-tested in issue_sync.test.ts)
// ---------------------------------------------------------------------------

/** The open/closed state (and reason) an issue should have for a target Status. */
export function issueStateForStatus(status: string): {
  state: IssueState;
  stateReason?: "completed" | "not_planned";
} {
  switch (status.toLowerCase()) {
    case "done":
      return { state: "closed", stateReason: "completed" };
    case "won't do":
    case "wont do":
      return { state: "closed", stateReason: "not_planned" };
    default:
      // Todo, In Progress, and anything unrecognized stay open.
      return { state: "open" };
  }
}

/**
 * Given the board item's current Status and the issue's actual open/closed
 * state, return the Status the board SHOULD hold to be consistent — or null
 * if it's already consistent (no write needed).
 *
 * The asymmetry matters: an OPEN issue is consistent with *either* open
 * status, so we leave "In Progress" alone and only fall back to "Todo" when
 * the board status is missing or terminal (i.e. the issue was reopened).
 */
export function reconciledStatus(
  currentStatus: string | null,
  issueState: IssueState,
  stateReason: IssueStateReason,
): BoardStatus | null {
  const cur = (currentStatus ?? "").toLowerCase();
  if (issueState === "open") {
    return OPEN_STATUSES.has(cur) ? null : "Todo";
  }
  const want: BoardStatus = stateReason === "not_planned" ? "Won't Do" : "Done";
  return cur === want.toLowerCase() ? null : want;
}

// ---------------------------------------------------------------------------
// Reconcile: issue → board
// ---------------------------------------------------------------------------

// Board ops use the PAT (BoardEnv); issue ops use the App (GhAppEnv).
export interface ReconcileEnv extends BoardEnv, GhAppEnv {
  DB: D1Database;
}

/**
 * Ensure `issue` is on the board with a Status consistent with its open/closed
 * state. Returns the resulting board status, or null if the issue was skipped
 * (e.g. it's actually a PR). Logs a board_events row whenever Status changes.
 */
export async function reconcileIssueToBoard(
  env: ReconcileEnv,
  repo: string,
  issue: GhIssue,
): Promise<string | null> {
  if (issue.isPullRequest) return null;

  // Idempotent — returns the existing item id if already on the board.
  const itemId = await addItemByContentId(env, issue.nodeId);

  const ref = await getItemRef(env, itemId);
  const current = ref?.status ?? null;
  const desired = reconciledStatus(current, issue.state, issue.stateReason);

  if (desired && desired.toLowerCase() !== (current ?? "").toLowerCase()) {
    await updateItemField(env, itemId, STATUS_FIELD, desired);
    await insertBoardEvent(env.DB, {
      item_id: itemId,
      repo,
      issue_number: issue.number,
      from_status: current,
      to_status: desired,
    });
    return desired;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Reconcile: board → issue (driven by an agent setting Status via MCP)
// ---------------------------------------------------------------------------

export interface ApplyStatusResult {
  itemId: string;
  fromStatus: string | null;
  toStatus: string;
  issueAction: "closed" | "reopened" | "none";
}

/**
 * Set a board item's Status and bring the backing GitHub issue's open/closed
 * state into line (close with the right reason, or reopen). Logs a
 * board_events row. The issue mutation only fires when the state actually
 * needs to change, so the resulting `issues` webhook reconciles to a no-op.
 */
export async function applyStatusToIssue(
  env: ReconcileEnv,
  itemId: string,
  toStatus: string,
): Promise<ApplyStatusResult> {
  const ref = await getItemRef(env, itemId);
  const fromStatus = ref?.status ?? null;

  await updateItemField(env, itemId, STATUS_FIELD, toStatus);

  let issueAction: "closed" | "reopened" | "none" = "none";
  if (ref?.repo && ref.issueNumber != null) {
    const target = issueStateForStatus(toStatus);
    if (target.state === "closed" && ref.issueState !== "closed") {
      await closeIssue(env, ref.repo, ref.issueNumber, target.stateReason ?? "completed");
      issueAction = "closed";
    } else if (target.state === "open" && ref.issueState === "closed") {
      await reopenIssue(env, ref.repo, ref.issueNumber);
      issueAction = "reopened";
    }
  }

  await insertBoardEvent(env.DB, {
    item_id: itemId,
    repo: ref?.repo ?? null,
    issue_number: ref?.issueNumber ?? null,
    from_status: fromStatus,
    to_status: toStatus,
  });

  return { itemId, fromStatus, toStatus, issueAction };
}

// ---------------------------------------------------------------------------
// Daily sweep — mirror every repo's issues onto the board
// ---------------------------------------------------------------------------

export interface IssueSyncEnv extends ReconcileEnv {
  /** User login whose repos are scanned (issues live in user repos). */
  GITHUB_USERNAME: string;
}

export interface IssueSyncSummary {
  repos: number;
  issuesSeen: number;
  reconciled: number;
  errors: number;
  error?: string;
}

/**
 * Scan every non-fork, non-archived repo for the configured user and reconcile
 * each of its issues onto the board. Catches anything missed between webhook
 * windows (issues opened/closed directly on GitHub). Failures on a single repo
 * or issue are logged and skipped — the sweep never crashes daily-sync.
 */
export async function runIssueSync(
  env: IssueSyncEnv,
): Promise<IssueSyncSummary> {
  const summary: IssueSyncSummary = {
    repos: 0,
    issuesSeen: 0,
    reconciled: 0,
    errors: 0,
  };

  let repos;
  try {
    repos = await listPublicRepos(env, env.GITHUB_USERNAME);
  } catch (err) {
    summary.error = `listPublicRepos failed: ${err instanceof Error ? err.message : String(err)}`;
    return summary;
  }

  for (const repo of repos) {
    if (repo.archived || repo.fork) continue;
    summary.repos += 1;
    let issues: GhIssue[];
    try {
      issues = await listAllIssues(env, repo.full_name);
    } catch (err) {
      summary.errors += 1;
      console.error(`[issue_sync] listAllIssues ${repo.full_name}: ${err}`);
      continue;
    }
    for (const issue of issues) {
      summary.issuesSeen += 1;
      try {
        const status = await reconcileIssueToBoard(env, repo.full_name, issue);
        if (status) summary.reconciled += 1;
      } catch (err) {
        summary.errors += 1;
        console.error(
          `[issue_sync] reconcile ${repo.full_name}#${issue.number}: ${err}`,
        );
      }
    }
  }

  return summary;
}
