// MCP tool definitions and execution handlers.

import type { Env } from "../index";
import { getSitePart } from "../lib/state";
import { createIssue, updateIssue } from "../lib/github";
import {
  addItemByContentId,
  updateItemField,
  getItemRef,
  listBoardItems,
  getProjectSchema,
} from "./board";
import { applyStatusToIssue } from "../pipelines/issue_sync";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export const TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "get_repo_context",
    description:
      "Everything the portfolio bot knows about a repo: project card, board items, recent log entries, draft status, skip status. Call this when starting work in any repo to orient yourself. Pass full owner/repo from git remote.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Full owner/repo (e.g. SirWhack/my-project)",
        },
      },
      required: ["repo"],
    },
  },
  {
    name: "get_site_status",
    description:
      "Overview of the portfolio automation bot: project count, pending drafts, last sync time, board items by status.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_board_schema",
    description:
      "Returns the project board's field definitions: every field name, type, and valid options. Call this before create_item or update_item to know which statuses, priorities, and kinds are available. Cached for 5 minutes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_items",
    description:
      "Query the personal project board (GitHub Projects v2). This board tracks work across all of the user's repos — features, bugs, chores. Filter by repo or status to scope results.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Filter by repo (owner/repo or short name)",
        },
        status: {
          type: "string",
          description: "Filter by status (e.g. In Progress, Todo, Backlog)",
        },
      },
    },
  },
  {
    name: "create_item",
    description:
      "Create a GitHub issue in a repo and add it to the cross-repo project board. Every board item is a real issue — repo is required. Keep titles short and descriptive (e.g. 'Add temporal tracking to graph'), written like a roadmap item a stranger would understand. Pass status; setting status to a closed value (Done / Won't Do) creates the issue already closed. Call get_board_schema first if you need valid field values.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Short, clear task title. Write it like a roadmap item a stranger would understand, not an implementation note.",
        },
        repo: {
          type: "string",
          description:
            "Required. The owner/repo to open the issue in — normally the repo you are working in.",
        },
        body: {
          type: "string",
          description: "Optional issue body / description.",
        },
        status: {
          type: "string",
          description: "Board status — call get_board_schema for valid values",
        },
        priority: { type: "string", description: "Priority level" },
        kind: {
          type: "string",
          description: "Item type (e.g. Bug, Feature, Chore)",
        },
      },
      required: ["title", "repo"],
    },
  },
  {
    name: "update_item",
    description:
      "Update an existing board item. Setting status drives the underlying GitHub issue's lifecycle: a closed status (Done / Won't Do) closes the issue with the matching reason; an open status (Todo / In Progress) reopens it if needed. Can also edit the issue title/body. Get item_id from list_items or create_item first.",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Board item node ID" },
        status: {
          type: "string",
          description: "New status — call get_board_schema for valid values",
        },
        priority: { type: "string", description: "New priority" },
        kind: { type: "string", description: "New kind/type" },
        title: { type: "string", description: "New issue title" },
        body: { type: "string", description: "New issue body" },
      },
      required: ["item_id"],
    },
  },
  {
    name: "close_item",
    description:
      "Mark a board item Done and close its GitHub issue (completed). Convenience for update_item with status=Done. Use when work is finished.",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Board item node ID" },
      },
      required: ["item_id"],
    },
  },
  {
    name: "trigger_daily_sync",
    description:
      "Run the full portfolio sync: refresh project metadata, discover new repos, sync roadmap from board, publish to site. Use after board changes to update the portfolio site immediately.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "trigger_repo_sync",
    description:
      "Process pending webhook events for a repo: draft log entries from recent commits, update now text, publish to the portfolio site.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Full owner/repo name",
        },
      },
      required: ["repo"],
    },
  },
];

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const FIELD_CANDIDATES: Record<string, string[]> = {
  priority: ["Priority"],
  kind: ["Type", "Kind", "Category"],
};

async function setFieldWithFallbacks(
  env: Env,
  itemId: string,
  argName: string,
  value: string,
): Promise<string | null> {
  const candidates = FIELD_CANDIDATES[argName];
  if (!candidates) return `unknown arg: ${argName}`;
  for (const fieldName of candidates) {
    try {
      await updateItemField(env, itemId, fieldName, value);
      return null;
    } catch {
      continue;
    }
  }
  return `no matching field for "${argName}"`;
}

async function getRepoContext(
  env: Env,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const repo = String(args.repo ?? "");
  if (!repo) return errorResult("repo is required");

  const shortName = repo.includes("/") ? repo.split("/")[1] : repo;

  const [projects, boardItems, log, drafts, cursors, skipRow] =
    await Promise.all([
      getSitePart<Array<Record<string, unknown>>>(env.DB, "projects"),
      // Live board read (ADR-0003) — not the stale daily roadmap snapshot.
      listBoardItems(env, repo).catch(() => [] as Array<Record<string, unknown>>),
      getSitePart<Array<Record<string, unknown>>>(env.DB, "log"),
      env.DB
        .prepare(
          `SELECT id, kind, status, notes, created_at
           FROM drafts WHERE source_repo = ?1
           ORDER BY created_at DESC LIMIT 10`,
        )
        .bind(repo)
        .all(),
      env.DB
        .prepare(
          `SELECT pipeline, last_sha, updated_at
           FROM cursors WHERE repo = ?1`,
        )
        .bind(shortName)
        .all(),
      env.DB
        .prepare(
          `SELECT reason, skipped_at FROM skipped_repos WHERE repo = ?1`,
        )
        .bind(shortName)
        .first<{ reason: string; skipped_at: number }>(),
    ]);

  const project =
    (projects ?? []).find(
      (p) =>
        p.slug === shortName ||
        String(p.links && (p.links as Record<string, unknown>).repo).includes(repo),
    ) ?? null;

  // boardItems is already scoped to this repo by listBoardItems above.

  const recentLogs = (log ?? [])
    .filter((l) => l.project === shortName)
    .slice(0, 5);

  return textResult(
    JSON.stringify(
      {
        repo,
        project,
        boardItems,
        recentLogs,
        drafts: drafts.results ?? [],
        cursors: cursors.results ?? [],
        skipped: skipRow
          ? { reason: skipRow.reason, skippedAt: skipRow.skipped_at }
          : null,
      },
      null,
      2,
    ),
  );
}

async function handleGetBoardSchema(env: Env): Promise<ToolResult> {
  try {
    const schema = await getProjectSchema(env);
    const fields: Array<Record<string, unknown>> = [];
    for (const [, def] of schema.fields) {
      const field: Record<string, unknown> = {
        name: def.name,
        type: def.type,
      };
      if (def.options) {
        field.options = [...def.options.keys()];
      }
      fields.push(field);
    }
    return textResult(JSON.stringify({ projectId: schema.projectId, fields }, null, 2));
  } catch (err) {
    return errorResult(
      `Failed to fetch schema: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function getSiteStatus(env: Env): Promise<ToolResult> {
  const [projects, roadmap, log, heldCount, parts] = await Promise.all([
    getSitePart<unknown[]>(env.DB, "projects"),
    getSitePart<Array<{ status: string }>>(env.DB, "roadmap"),
    getSitePart<unknown[]>(env.DB, "log"),
    env.DB
      .prepare(
        "SELECT COUNT(*) as count FROM drafts WHERE status = 'held_for_review'",
      )
      .first<{ count: number }>(),
    env.DB
      .prepare(
        "SELECT name, updated_at FROM site_parts ORDER BY updated_at DESC",
      )
      .all<{ name: string; updated_at: number }>(),
  ]);

  const statusCounts: Record<string, number> = {};
  for (const item of roadmap ?? []) {
    const s = item.status ?? "unknown";
    statusCounts[s] = (statusCounts[s] ?? 0) + 1;
  }

  const lastSync = (parts.results ?? [])[0];

  return textResult(
    JSON.stringify(
      {
        projectCount: (projects ?? []).length,
        logEntryCount: (log ?? []).length,
        heldForReview: heldCount?.count ?? 0,
        roadmapByStatus: statusCounts,
        lastSync: lastSync
          ? {
              part: lastSync.name,
              at: new Date(lastSync.updated_at * 1000).toISOString(),
            }
          : null,
      },
      null,
      2,
    ),
  );
}

async function handleListItems(
  env: Env,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const items = await listBoardItems(
      env,
      args.repo as string | undefined,
      args.status as string | undefined,
    );
    return textResult(JSON.stringify(items, null, 2));
  } catch (err) {
    return errorResult(
      `Failed to list items: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleCreateItem(
  env: Env,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const title = String(args.title ?? "");
  if (!title) return errorResult("title is required");

  const repo = args.repo ? String(args.repo) : null;
  if (!repo) {
    return errorResult(
      "repo is required — every board item is a real GitHub issue (ADR-0003).",
    );
  }
  const body = args.body ? String(args.body) : undefined;

  try {
    // Create the issue (open), then add it to the board.
    const issue = await createIssue(env, repo, title, body);
    const itemId = await addItemByContentId(env, issue.nodeId);

    const fieldsSet: string[] = [];
    const fieldErrors: string[] = [];

    // Status drives issue lifecycle — route it through the reconciler so a
    // Done/Won't Do at creation also closes the freshly-opened issue.
    if (args.status) {
      try {
        await applyStatusToIssue(env, itemId, String(args.status));
        fieldsSet.push("status");
      } catch (err) {
        fieldErrors.push(
          `status: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    for (const argName of ["priority", "kind"] as const) {
      if (!args[argName]) continue;
      const err = await setFieldWithFallbacks(
        env,
        itemId,
        argName,
        String(args[argName]),
      );
      if (err) fieldErrors.push(err);
      else fieldsSet.push(argName);
    }

    return textResult(
      JSON.stringify({
        itemId,
        title,
        repo,
        issueUrl: issue.htmlUrl,
        issueNumber: issue.number,
        fieldsSet,
        ...(fieldErrors.length ? { fieldErrors } : {}),
      }),
    );
  } catch (err) {
    return errorResult(
      `Failed to create item: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleUpdateItem(
  env: Env,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const itemId = String(args.item_id ?? "");
  if (!itemId) return errorResult("item_id is required");

  const hasAny = ["status", "priority", "kind", "title", "body"].some(
    (k) => args[k],
  );
  if (!hasAny) {
    return errorResult(
      "No fields to update. Provide status, priority, kind, title, or body.",
    );
  }

  const results: string[] = [];

  // Status first — it drives the issue's open/closed state via the reconciler.
  if (args.status) {
    try {
      const r = await applyStatusToIssue(env, itemId, String(args.status));
      const suffix = r.issueAction !== "none" ? ` (issue ${r.issueAction})` : "";
      results.push(`status → ${r.toStatus}${suffix}`);
    } catch (err) {
      results.push(`status: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const argName of ["priority", "kind"] as const) {
    if (!args[argName]) continue;
    const value = String(args[argName]);
    const err = await setFieldWithFallbacks(env, itemId, argName, value);
    results.push(err ? `${argName}: ${err}` : `${argName} → ${value}`);
  }

  // Title/body edits go to the backing issue.
  if (args.title || args.body) {
    try {
      const ref = await getItemRef(env, itemId);
      if (!ref?.repo || ref.issueNumber == null) {
        results.push("title/body: item has no backing issue");
      } else {
        await updateIssue(env, ref.repo, ref.issueNumber, {
          ...(args.title ? { title: String(args.title) } : {}),
          ...(args.body ? { body: String(args.body) } : {}),
        });
        if (args.title) results.push(`title → ${String(args.title)}`);
        if (args.body) results.push("body updated");
      }
    } catch (err) {
      results.push(
        `title/body: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return textResult(results.join("\n"));
}

async function handleCloseItem(
  env: Env,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const itemId = String(args.item_id ?? "");
  if (!itemId) return errorResult("item_id is required");

  try {
    const r = await applyStatusToIssue(env, itemId, "Done");
    const suffix = r.issueAction !== "none" ? ` (issue ${r.issueAction})` : "";
    return textResult(`Closed item ${itemId} → Done${suffix}`);
  } catch (err) {
    return errorResult(
      `Failed to close: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleTriggerDailySync(env: Env): Promise<ToolResult> {
  try {
    const instance = await env.DAILY_SYNC.create({
      params: { source: "manual" },
    });
    return textResult(
      JSON.stringify({ triggered: true, instanceId: instance.id }),
    );
  } catch (err) {
    return errorResult(
      `Failed to trigger: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleTriggerRepoSync(
  env: Env,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const repo = String(args.repo ?? "");
  if (!repo) return errorResult("repo is required");

  try {
    const sanitized = repo.replace(/\//g, "__");
    const instanceId = `${sanitized}__mcp__${Date.now()}`;
    const instance = await env.PER_REPO_UPDATE.create({
      id: instanceId,
      params: {
        repo,
        delivery_id: `mcp-${Date.now()}`,
        event: "push",
      },
    });
    return textResult(
      JSON.stringify({ triggered: true, instanceId: instance.id, repo }),
    );
  } catch (err) {
    return errorResult(
      `Failed to trigger: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function executeTool(
  env: Env,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "get_repo_context":
      return getRepoContext(env, args);
    case "get_site_status":
      return getSiteStatus(env);
    case "get_board_schema":
      return handleGetBoardSchema(env);
    case "list_items":
      return handleListItems(env, args);
    case "create_item":
      return handleCreateItem(env, args);
    case "update_item":
      return handleUpdateItem(env, args);
    case "close_item":
      return handleCloseItem(env, args);
    case "trigger_daily_sync":
      return handleTriggerDailySync(env);
    case "trigger_repo_sync":
      return handleTriggerRepoSync(env, args);
    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
