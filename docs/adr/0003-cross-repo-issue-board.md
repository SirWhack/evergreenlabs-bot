# ADR-0003: Cross-repo issue board with a two-layer lifecycle

- **Status:** Accepted
- **Date:** 2026-05-30
- **Tracks:** TBD
- **Supersedes:** Parts of [ADR-0002](0002-mcp-server.md) — §D2 (user-owned board), §D6 (draft items allowed), and the `close_item` = archive-only semantics.
- **Builds on:** [ADR-0001](0001-cloud-migration.md), [ADR-0002](0002-mcp-server.md)

## Context

ADR-0002 added an MCP server so agents could manage a GitHub Projects v2 board. As built, that board is a **manually-curated list with a site-publishing pipeline bolted on**, but it is described — and its MCP tools are named — as if it were a cross-repo issue tracker. The gap between those two framings is the source of ongoing confusion. Concretely, the current system has five structural problems:

1. **No discovery.** Issues reach the board only when an agent calls `create_item` or a human adds them in the GitHub UI. Nothing scans the user's repos and reconciles their open issues onto the board. `filter.ts` does not even handle the `issues` webhook event, so an issue opened or closed directly on GitHub is invisible to the bot.

2. **Two credentials, forced by a platform limit.** The board is user-owned, and **GitHub Apps cannot access user-owned Projects v2**. So every board read/mutation runs through a classic PAT (`GITHUB_PAT_PROJECTS`), while only the underlying issue is created with the App token. A single "create issue + add to board" spans two auth systems (`board.ts`), and a long-lived user PAT lives in Worker secrets. This is also the root of board items #19 (unify GraphQL auth) and #21 (split `github.ts`).

3. **Split-brain repo identity.** A real issue carries its repo intrinsically (`content.repository.nameWithOwner`); a draft item only has a repo if a custom "Repo" text field was hand-filled. `listBoardItems` and `roadmap_sync` both coalesce these two sources, and drafts routinely end up with `repo: null`.

4. **One-way traps in the agent contract.** `create_item`'s optional `repo` param silently forks between creating a draft and a real issue. `update_item` cannot set repo, title, or body — so a draft made without a repo can never be linked to one via MCP. `close_item` *archives the board card but leaves the GitHub issue open*, so agents "finishing" work leave open issues behind.

5. **No lifecycle.** A GitHub issue has only two durable states (`open`/`closed`). Open/closed alone cannot express where a feature is in its life.

This ADR rethinks the board into a true cross-repo issue tracker with an explicit lifecycle, and removes the dual-auth and draft complexity.

## Decisions

### D1 — Board on an org (`EvergreenLabs-US`); repos stay on the user; a PAT bridges the two

The board moves to an **org-owned** Projects v2 project (`EvergreenLabs-US`), but the tracked repos **stay under the `SirWhack` user account** — they are not migrated.

This creates a cross-account boundary that decides the auth model. A **GitHub App installation is scoped to a single account**: an install on the org cannot read the user's personal-repo issues (so it can't even add them to the project), and the existing user install cannot touch the org's Projects v2. No single App installation can drive both sides.

A **PAT owned by the user is not installation-scoped** — it reaches everything that user can reach, which (because the user is an org admin) includes both the personal repos' issues *and* the org project. So the credentials split by surface:

- **GitHub App** (stays installed on `SirWhack`, unchanged) — webhook intake, repo reads (commits/README/repo list), website publish, and **issue create / close / reopen / edit** on the user repos.
- **PAT** (`GITHUB_PAT_PROJECTS`, `project` scope) — **all org-project operations**: add item, set fields, list items, read schema (`patGraphQL` against `organization(login:){ projectV2 }`).

Consequences:
- **The App is *not* installed on the org**, and **no repos are moved.** This sidesteps the org-install friction entirely.
- The PAT is **retained** (this revises the original §D1 intent to drop it), but is now narrowly scoped to the org project rather than also doing reads the App can do. #19 still improves (roadmap_sync shares the org `patGraphQL` path); #21 is unaffected.
- `EvergreenLabs-US` must permit the PAT under Settings → Third-party Access → Personal access tokens (new orgs often restrict classic/fine-grained PATs by default), or board calls 403.
- The App still needs `Issues: Read & write` on the user repos and an `issues` webhook subscription (see D5).

Rejected: **moving the repos into the org** (would let one org App install do everything and drop the PAT, matching the original §D1 — but it churns repo URLs, `GITHUB_USERNAME`, website refs, and project-card links for no functional gain over the PAT bridge). Rejected: **two App installations** (org + user) — still can't add a user-repo issue to the org project, since the org token can't resolve user-repo issue content.

### D2 — Two-layer state: lifecycle on the Status field, open/closed as a projection

The **board Status single-select field is the source of truth for lifecycle**. The GitHub issue's `open`/`closed` state is a *derived projection* of Status, reconciled in both directions. This is the central decision: it lets a binary issue state carry a multi-stage lifecycle without inventing a parallel state store.

| Layer | Lives in | Role |
|---|---|---|
| Lifecycle | Projects v2 **Status** field | the state machine the bot and agents work against day-to-day |
| Issue state | GitHub `open`/`closed` + `state_reason` | durable projection; drives GitHub notifications and closes the loop |

### D3 — Lean lifecycle: four statuses across the open/closed boundary

The Status field has exactly four options:

```
OPEN (issue open)          CLOSED (issue closed)
  Todo                       Done       → state_reason: completed
  In Progress                Won't Do   → state_reason: not_planned
```

**Reconcile rules (bidirectional, idempotent):**
- Status → `Done` ⇒ close issue as `completed`; Status → `Won't Do` ⇒ close as `not_planned`.
- Status moved from a closed column back to `Todo`/`In Progress` ⇒ reopen the issue.
- Issue closed directly on GitHub ⇒ set Status from `state_reason` (`completed` → `Done`, `not_planned` → `Won't Do`); reopened ⇒ Status → `Todo`.

Four statuses is more expressive than raw open/closed (the original concern) while staying low-maintenance for a single developer. Richer lifecycles (Backlog/In Review/Blocked, or an Iteration field) were considered and rejected for now as bookkeeping overhead; the Status field can gain options later without changing the reconcile machinery.

### D4 — Every board item is a real GitHub issue; no drafts

Draft items are removed. `create_item` requires `repo` and always creates a real issue in that repo, then adds it to the board. `createDraftItem` / `addProjectV2DraftIssue` are deleted.

This eliminates split-brain repo identity (repo is always intrinsic to the issue), the one-way repo trap, and the hidden draft-vs-issue fork in `create_item`. Every item has a URL and a repo by construction. The cost: a not-yet-scoped idea must still belong to *a* repo — acceptable, since cross-cutting ideas can live in the bot's own repo or a dedicated `ideas` repo.

Rejected: keeping drafts with a "promote to issue" path (preserves the two-class data model this ADR is trying to remove).

### D5 — Auto-ingest issues across all repos (webhook + daily reconcile)

The board becomes a true cross-repo mirror via two reconcile paths, both calling a shared `issue_sync` reconciler:

1. **Event-driven.** `filter.ts` gains the `issues` event (actions: `opened`, `closed`, `reopened`, `edited`, `labeled`). Each event reconciles that single issue onto the board (ensure present, sync Status from open/closed state).
2. **Daily sweep.** `daily-sync` enumerates the user's repos (`listPublicRepos`) and lists every repo's issues with **real pagination** (today's `first: 100` cap is removed), reconciling each onto the board and catching anything missed between webhook windows.

The App's webhook subscription must add `issues`, and App permissions must include `Issues: Read & write` (write is needed for the D3 open/close reconcile).

### D6 — `close_item` folds into status transitions

There is no separate "close" verb. `update_item(status: "Done")` (or `"Won't Do"`) performs the D3 reconcile — setting Status *and* closing the GitHub issue with the right reason. The MCP `close_item` tool is removed (or kept as thin sugar for `update_item(status:"Done")`). `update_item` gains the ability to set `status`, `priority`, `kind` — and, since items are now always issues, may also edit `title`/`body` via the issues API.

### D7 — A `board_events` table records the lifecycle timeline

A new D1 table logs every status transition: `(item_id, repo, issue_number, from_status, to_status, at)`. This gives the lifecycle a queryable history (not just current state) and a hook for downstream automation — a transition into `Done` is the natural trigger to feed the site log / "now" text ("shipped X"), finally connecting the board to the existing `log_drafter` / `now_updater` pipelines instead of running as a side channel.

### D8 — roadmap_sync stays board→site, with terminal statuses routed to the log

`roadmap_sync` continues to read the board and publish `site_parts.roadmap`, but now via the App (D1). `HIDDEN_STATUSES` keeps `Done`/`Won't Do` out of the *roadmap* section; `Done` transitions instead feed the *log* (D7). The site roadmap shows live work (`Todo`, `In Progress`); shipped work appears in the log.

## Tool inventory (changes from ADR-0002)

| Tool | Change |
|---|---|
| `create_item` | `repo` now **required**; always creates a real issue. Draft path removed. |
| `update_item` | Can set `status` (drives issue open/close per D3), `priority`, `kind`, and now `title`/`body`. |
| `close_item` | **Removed** (folded into `update_item(status:"Done")`), or kept as sugar. |
| `list_items` | Now paginates; reads via App (no PAT). |
| `get_repo_context` | Should read the board live (or clearly label the D1 snapshot as stale). |
| `get_board_schema`, `get_site_status`, `trigger_daily_sync`, `trigger_repo_sync` | Unchanged. |

## Consequences

**Positive:**
- The board becomes a real cross-repo issue tracker: every open issue across the user's repos is mirrored, with one explicit lifecycle.
- No repo migration and no org App install — the App stays on the user account; a project-scoped PAT bridges to the org board (revised §D1).
- No split-brain repo identity, no draft second-class items, no one-way traps; the agent contract gets simpler and harder to misuse.
- Board and GitHub stay consistent — finishing work closes the issue; closing an issue updates the board.
- `Done` transitions feed the existing editorial pipeline, unifying the board with the site log.

**Negative:**
- Retains a user-owned PAT (revised §D1) — a long-lived secret on the Worker, and the org must be configured to permit it. The single-credential ideal is only reachable by later moving the repos into the org.
- One-time setup: create the org project, grant the App `Issues: R/W` + `issues` webhook on the user repos, and set the Status options to exactly `Todo` / `In Progress` / `Done` / `Won't Do`.
- Auto-ingest is the largest new surface (webhook handling + paginated daily reconcile + reconcile state machine).
- Bidirectional open/closed ↔ Status reconcile must be idempotent and loop-safe (a board edit closes an issue, which fires an `issues` webhook, which must not re-trigger work) — mirrors the existing self-feedback guard in `log_drafter`.
- Existing draft items on the board must be migrated to real issues or dropped during cutover.

**Followups (out of scope here):**
- Richer lifecycle (Backlog / In Review / Blocked, or an Iteration/target-date field) if four statuses prove too coarse.
- Weekly "shipped" digest from `board_events`.
- Labels-as-opt-in ingestion if the full-repo mirror proves too noisy.
