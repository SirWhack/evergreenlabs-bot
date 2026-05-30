<!-- context-kernel-freshness
graph: 4828895ec2ab8c46292fc502e3c028e8b68915c679ff81f463cf9148983976a0
source-tree: 5c60e69c71793831066c7c1271c0f372de0edd8f0a6b329cdfeaadfcbd56271c
materialized: 2026-05-27T21:03:14Z
-->

This scope provides the core library layer for the Evergreen Labs bot, handling GitHub API interactions, LLM communication, event filtering, commit processing, and site data publishing. It serves as the foundational infrastructure that higher-level bot logic depends on, abstracting away external service details behind clean interfaces.

The GitHub module (`github.ts`) is the most substantial component, managing all GitHub App authentication and API access. It exports `GhAppEnv` (requiring `GITHUB_APP_ID`, `GITHUB_APP_INSTALLATION_ID`, and `GITHUB_APP_PRIVATE_KEY`) and provides `getInstallationToken` for JWT-based authentication. The module exposes `ghFetch` and `ghGraphQL` as generic API callers, plus domain-specific functions like `fetchCommitDetail` (returning a `CommitDetail` with sha, message, author info, and file changes), `fetchReadme`, and `listPublicRepos` (returning `GhRepo[]`). Authentication is handled internally through private helpers that sign JWTs, fetch installation tokens, and cache them with a refresh margin.

The LLM module (`llm.ts`) provides a unified interface for AI model interactions. It exports `LlmEnv` (requiring `OPENROUTER_API_KEY`, `LLM_MODEL`, and `DIFFUSION_KEY`), along with `ChatOpts` and `ChatResult` types. The primary functions are `chat` (sending system/user prompts and returning text responses) and `chatJson` (which parses structured JSON responses). A `stripFences` utility removes markdown code fences from LLM output. The module internally resolves providers based on model names, supporting both OpenRouter and a custom Inception endpoint.

The filter module (`filter.ts`) determines which incoming webhook events should be processed. It exports `shouldEnqueue` (checking event type, payload structure, and expected owner) and `extractRecord` (producing an `EventRecord` with delivery_id, event, action, repo, sha, branch, and timestamp). The commits module (`commits.ts`) processes pending events into unique commits via `extractUniqueCommits`, returning `DrainedCommit` objects with sha, repoFullName, and repoShortName. The publish module (`publish.ts`) handles reading, merging, and writing site data to a GitHub repository, using `renderSiteData` and `parseSiteData` for serialization, and `publishSiteData` as the main entry point that deep-merges partial data into existing site content.

## Recommended documentation

This scope has 83 code entities across 1 files but no reference documentation. To create one: `/init-reference lib`

