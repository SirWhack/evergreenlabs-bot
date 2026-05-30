<!-- context-kernel-freshness
graph: 4828895ec2ab8c46292fc502e3c028e8b68915c679ff81f463cf9148983976a0
source-tree: 494de605f3bd1b31deafff8b0132e447fc7ef6d3438347427372b982889a6ee1
materialized: 2026-05-27T21:03:14Z
-->

This scope contains two standalone scripts — `eval-voices.ts` and `regen-voices.ts` — that are not part of the main bot runtime. They are developer tooling for testing and regenerating the voice definitions that the bot uses to generate commit messages. Neither script exports anything; each is invoked directly via `tsx` or `ts-node` and relies on environment variables loaded from a `.env` file via a private `loadDotenv` helper.

`eval-voices.ts` runs an offline evaluation of the bot’s voice system against recent local commits. It uses `execSync` to run `git log` and `git diff` commands, producing an array of `LocalCommit` objects (sha, message, files, additions, deletions). For each commit, it calls the private `complete` function, which sends a system prompt and a user prompt (built by `buildUserPrompt`) to either OpenRouter or an Inception endpoint, returning a `CompletionResult` (text, model, latencyMs). The script iterates over a set of `VOICE_OPTIONS` and `MODELS`, collecting results into `EvalRow` objects, then prints a summary table via `printSummary`. It imports `getVoice` and the `Voice` type from `../src/lib/voices` to know which voice definitions to test.

`regen-voices.ts` is a more complex script that regenerates the voice definitions stored in a Cloudflare D1 database. It fetches commit data from the GitHub API via the private `ghFetch` helper, which uses `execSync` to call `gh` CLI commands. It retrieves commit details (`CommitDetail`), repo metadata (description, language, topics, readme), and then uses the private `llmChat` function to call OpenRouter for regenerating three voice fields: `regenLogEntry`, `regenProjectBlurb`, and `regenNowText`. Each of these functions takes a draft object and returns a regenerated string. The script writes results directly to the D1 database using `d1Query` and `d1Exec`, which shell out to `wrangler d1 execute`. It also imports `getVoice` from `../src/lib/voices` to access existing voice definitions. The `main` function orchestrates the full pipeline: fetching commits, calling the LLM for each voice field, and updating the database, with a `DRY_RUN` flag to skip writes.

Both scripts share a pattern of shelling out to CLI tools (`git`, `gh`, `wrangler`) rather than using SDKs, and both use `node:child_process.execSync` for synchronous execution. They depend on the `../src/lib/voices` module for voice definitions but are otherwise self-contained. The `eval-voices.ts` script is for local testing and comparison, while `regen-voices.ts` is a production maintenance script that updates the bot’s voice data in the D1 database.

## Recommended documentation

This scope has 27 code entities across 1 files but no reference documentation. To create one: `/init-reference scripts`

