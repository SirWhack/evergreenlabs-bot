<!-- context-kernel-freshness
graph: 4828895ec2ab8c46292fc502e3c028e8b68915c679ff81f463cf9148983976a0
source-tree: 180d912e7a469a7b5f50b6dfd27b532e85714214a97d0ea64dedbbab5eed8ab4
materialized: 2026-05-27T21:03:14Z
-->

This scope handles the core content generation and synchronization pipelines for the Evergreen Labs bot. It is responsible for discovering new repositories, drafting project introductions, generating changelog entries from commits, updating the "now" page with weekly summaries, synchronizing project metadata from GitHub, and syncing roadmap items from GitHub Projects. Each pipeline is a self-contained module that reads from and writes to the bot's state layer, using LLM calls to produce human-readable content.

The `introduce.ts` pipeline discovers and introduces new repositories. Its public entry points are `introduceRepo(env, repoFullName)` which processes a single repo, and `introduceOrphans(env)` which scans all public repos for the configured GitHub username and introduces any that haven't been seen before. Both return `IntroduceResult` objects with a `slug` and `accepted` flag. Internally, `introduceOne` fetches the README via `fetchReadme`, drafts a blurb using `draftBlurb` (which calls `chat` with a system prompt and user template), and inserts the result into the D1 database via `insertDraft` or `insertSkippedRepo`. The `project_sync.ts` module complements this by scanning repos and building `ProjectEntry` objects with metadata like tags, links, and status, exposed through `runProjectSync(env)` which returns a `ProjectSyncSummary`.

The `log_drafter.ts` pipeline converts commit details into draft log entries. Its main function `draftLogEntries(commits, deps)` takes an array of `CommitDetail` objects and a `LogDrafterDeps` (which includes an `LlmEnv` and a list of known projects), and returns a `LogDrafterResult` containing `LogDraft` objects. Each commit is first judged for log-worthiness via the private `judge` function, then drafted into a body via `draftBody`. The `passesSanity` function validates the generated payload, and `projectSlugForRepo` maps repo names to project slugs. The `now_updater.ts` pipeline generates the weekly "now" page update through `updateNow(env)`, which reads recent log entries from state, calls the LLM to synthesize them into a `NowPayload`, and writes the result back to the database.

The `roadmap_sync.ts` pipeline synchronizes GitHub Project v2 items into the bot's state. Its public function `runRoadmapSync(env)` fetches items using a GraphQL query (`PROJECTS_V2_QUERY`), filters by status, generates AI commentary for each item via `commentaryUserPrompt`, and returns a `RoadmapSyncSummary`. All pipelines depend on the shared `../lib/` modules for GitHub API access (`fetchReadme`, `listPublicRepos`, `GhAppEnv`), LLM interaction (`chat`, `chatJson`, `LlmEnv`), state management (`getSitePart`, `putSitePart`, `insertDraft`, `isSkipped`), site conventions (`metaString`, `normalizeTags`, `SKIP_NAMES`), and voice configuration (`getVoice`). The pipelines follow a consistent pattern: they accept an environment interface, perform work using LLM calls and database operations, and return typed result objects that summarize what was accomplished.

## Recommended documentation

This scope has 49 code entities across 1 files but no reference documentation. To create one: `/init-reference pipelines`

