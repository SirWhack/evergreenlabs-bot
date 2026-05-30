<!-- context-kernel-freshness
graph: 4828895ec2ab8c46292fc502e3c028e8b68915c679ff81f463cf9148983976a0
source-tree: d730e5f1c603b9459cca80e21ece04164a481c1bc69a806b88780711056e4599
materialized: 2026-05-27T21:03:14Z
-->

This scope implements the Model Context Protocol (MCP) server for the Evergreen Labs bot, exposing GitHub Project board operations as callable tools that an AI assistant can invoke. It acts as the bridge between the MCP protocol layer and the GitHub GraphQL API, handling JSON-RPC request dispatch, tool registration, and board data operations. The scope's primary responsibility is to translate high-level tool invocations into concrete GitHub API calls while managing authentication, schema caching, and response formatting.

The public entry point is `handleMcp` in `handler.ts`, which accepts an HTTP `Request`, parses it as a JSON-RPC 2.0 message, and dispatches it to the appropriate handler. The private `dispatch` function routes requests based on the method field, supporting `initialize`, `tools/list`, `tools/call`, and `resources/list` methods. Tool definitions are declared in `TOOL_DEFINITIONS` (an array of `ToolDef` objects with name, description, and inputSchema), and the `executeTool` function in `tools.ts` maps tool names to private handler functions like `handleCreateItem`, `handleUpdateItem`, `handleCloseItem`, `handleListItems`, `handleGetBoardSchema`, `getRepoContext`, `getSiteStatus`, `handleTriggerDailySync`, and `handleTriggerRepoSync`.

The board operations in `board.ts` provide the core GitHub Project integration. `getProjectSchema` fetches and caches the project's field definitions (with a TTL-based cache invalidated by `invalidateSchemaCache`), returning a `ProjectSchema` containing a map of `FieldDef` objects. `createDraftItem` creates a draft board item, while `createIssueAndAddToBoard` creates a real GitHub issue and adds it to the board using GitHub App authentication (via `IssueItemEnv`). `updateItemField` sets a field value on an item, `archiveItem` archives an item, and `listBoardItems` queries items with optional repo and status filters, returning `BoardItem` objects. All GraphQL calls go through the private `patGraphQL` helper, which authenticates using the `BoardEnv` configuration (PAT, username, project number).

This scope depends on the application's `Env` type from `../index` for environment configuration, and on `getSitePart` from `../lib/state` for repository context lookups. The board module is self-contained with no imports beyond standard libraries, making it a clean GraphQL client layer. The overall architecture follows a layered pattern: the MCP handler receives HTTP requests, the tools layer translates MCP tool calls into domain operations, and the board module executes those operations against the GitHub API, with each layer hiding its implementation details behind well-defined interfaces.

## Recommended documentation

This scope has 46 code entities across 1 files but no reference documentation. To create one: `/init-reference mcp`

