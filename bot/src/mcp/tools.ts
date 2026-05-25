// MCP tool definitions and execution handlers.

import type { Env } from "../index";
import { getSitePart } from "../lib/state";
import {
  createDraftItem,
  updateItemField,
  archiveItem,
  listBoardItems,
  getProjectSchema,
} from "./board";

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
      "Add an item to the user's personal project board. This board tracks work across all repos — it is published to the user's portfolio website as a public roadmap. Keep titles short and descriptive (e.g. 'Add temporal tracking to graph'). Always pass repo with the owner/repo of the repo you are working in. Always pass status. Call get_board_schema first if you need valid field values.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "Short, clear task title. Write it like a roadmap item a stranger would understand, not an implementation note.",
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
        repo: {
          type: "string",
          description:
            "The owner/repo this item belongs to. Always set this to the repo you are working in.",
        },
      },
      required: ["title"],
    },
  },
  {
    name: "update_item",
    description:
      "Update fields on an existing board item. Get item_id from list_items or create_item first.",
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
      },
      required: ["item_id"],
    },
  },
  {
    name: "close_item",
    description:
      "Archive a board item (marks it done and removes from active view). Use when work is complete.",
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
  status: ["Status"],
  priority: ["Priority"],
  kind: ["Type", "Kind", "Category"],
  repo: ["Repository", "Repo"],
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

  const [projects, roadmap, log, drafts, cursors, skipRow] =
    await Promise.all([
      getSitePart<Array<Record<string, unknown>>>(env.DB, "projects"),
      getSitePart<Array<Record<string, unknown>>>(env.DB, "roadmap"),
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

  const boardItems = (roadmap ?? []).filter(
    (r) =>
      r.repo === repo || String(r.repo ?? "").endsWith(`/${shortName}`),
  );

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

  try {
    const itemId = await createDraftItem(env, title);
    const fieldsSet: string[] = [];
    const fieldErrors: string[] = [];

    for (const argName of ["status", "priority", "kind", "repo"] as const) {
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

  const updates: Array<[string, string]> = [];
  for (const argName of ["status", "priority", "kind"] as const) {
    if (args[argName]) updates.push([argName, String(args[argName])]);
  }
  if (updates.length === 0) {
    return errorResult(
      "No fields to update. Provide status, priority, or kind.",
    );
  }

  const results: string[] = [];
  for (const [argName, value] of updates) {
    const err = await setFieldWithFallbacks(env, itemId, argName, value);
    results.push(err ? `${argName}: ${err}` : `${argName} → ${value}`);
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
    await archiveItem(env, itemId);
    return textResult(`Archived item ${itemId}`);
  } catch (err) {
    return errorResult(
      `Failed to archive: ${err instanceof Error ? err.message : String(err)}`,
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
