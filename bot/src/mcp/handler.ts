// MCP Streamable HTTP handler. Implements the JSON-RPC 2.0 subset needed
// for a tool-only MCP server: initialize, tools/list, tools/call, ping.
// No external dependencies — the protocol is simple enough for our
// synchronous, non-streaming tool surface.

import type { Env } from "../index";
import { TOOL_DEFINITIONS, executeTool } from "./tools";

const PROTOCOL_VERSION = "2025-03-26";
const SERVER_NAME = "evergreenlabs-bot";
const SERVER_VERSION = "1.0.0";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id?: string | number;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string };
  id: string | number | null;
}

export async function handleMcp(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.method === "DELETE") {
    return new Response(null, { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(rpcError(null, -32700, "Parse error"));
  }

  if (Array.isArray(body)) {
    const responses: JsonRpcResponse[] = [];
    for (const msg of body) {
      const resp = await dispatch(msg as JsonRpcRequest, env);
      if (resp) responses.push(resp);
    }
    if (responses.length === 0) return new Response(null, { status: 202 });
    return jsonResponse(
      responses.length === 1 ? responses[0] : responses,
    );
  }

  const resp = await dispatch(body as JsonRpcRequest, env);
  if (!resp) return new Response(null, { status: 202 });
  return jsonResponse(resp);
}

async function dispatch(
  msg: JsonRpcRequest,
  env: Env,
): Promise<JsonRpcResponse | null> {
  if (!msg || msg.jsonrpc !== "2.0" || !msg.method) {
    return msg?.id != null
      ? rpcError(msg.id ?? null, -32600, "Invalid request")
      : null;
  }

  const id = msg.id ?? null;
  const isNotification = msg.id === undefined;

  switch (msg.method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });

    case "notifications/initialized":
      return null;

    case "ping":
      return rpcResult(id, {});

    case "tools/list":
      return rpcResult(id, { tools: TOOL_DEFINITIONS });

    case "tools/call": {
      const params = msg.params ?? {};
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await executeTool(env, name, args);
        return rpcResult(id, result);
      } catch (err) {
        return rpcResult(id, {
          content: [
            {
              type: "text",
              text: `Internal error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

function rpcResult(
  id: string | number | null,
  result: unknown,
): JsonRpcResponse {
  return { jsonrpc: "2.0", result, id };
}

function rpcError(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", error: { code, message }, id };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
