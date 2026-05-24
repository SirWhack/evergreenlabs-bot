---
name: site-bot
description: Scaffold a sibling automation bot for a personal site or portfolio — pulls GitHub activity, drafts log entries and project cards via a local LLM, writes back through a regenerate step. Use when the user wants to automate updates to a static-ish website whose content lives in one canonical file (JSON, JS module, YAML, etc.).
---

<what-to-do>

Walk the user through standing up a site-automation bot. The reference implementation lives at `evergreenlabs-bot/` (this repo); use it as the canonical example — read its source freely while adapting.

Goal: produce a sibling repo to the user's website with:
- A Python package that owns canonical content as JSON files.
- Pipelines that draft updates from GitHub activity via a local LLM.
- A `publish` step that regenerates the website's content file and commits/pushes.
- A scheduler integration so it can run autonomously.

## Preconditions

Before scaffolding, confirm with the user:

1. **Target website exists** as a git repo. Get the path.
2. **One canonical content file** holds everything the site renders (a single JS module like `siteData.js`, or a single JSON, or a single YAML — anything Vite/Astro/Next can import). If the site sprawls across many files, this pattern doesn't fit cleanly; stop and discuss.
3. **GitHub username** and which repos to track (all public, an allowlist, or include private with a `repo`-scoped PAT).
4. **Local LLM** is OpenAI-compatible. Get the base URL and model name. (LM Studio, vLLM, llama.cpp server, Ollama-in-OpenAI-mode all work.)
5. **Project v2 board number** (optional, for the roadmap section).

If any of these are unclear, ask before writing code. Don't guess.

## Inputs to gather (one short round of questions)

- `WEBSITE_REPO_PATH` — absolute path to the site repo.
- `WEBSITE_SITEDATA_REL` — relative path to the content file from that root (e.g. `src/content/siteData.js`).
- Content file format — JS module exporting `SITE`, JSON, YAML, etc. The reference impl handles JS-module-exporting-SITE; adapt the bootstrap and publish steps if the format differs.
- `GITHUB_USERNAME`, `GITHUB_TOKEN` (optional), `GITHUB_PROJECT_NUMBER` (optional).
- `LLM_BASE_URL`, `LLM_MODEL`.

## Scaffold

Pick a sibling path. Default: `<website-repo>-bot`. Confirm.

Copy or adapt from `evergreenlabs-bot/`. Files that are universal (work for any site):

- `pyproject.toml`, `.gitignore`, `.env.example`, `README.md`
- `src/<package>/config.py` — env loading
- `src/<package>/github_client.py`, `github_projects.py` — API access
- `src/<package>/llm_client.py` — OpenAI-compatible wrapper. Includes a `REASONING_OVERHEAD_TOKENS` constant for Gemma-4 / Qwen-3.x style models that emit chain-of-thought into `reasoning_content`; raise it if the user's model is particularly verbose.
- `src/<package>/state.py` — sqlite cursors and skiplist
- `src/<package>/drafts.py` — review queue + canonical site store
- `src/<package>/review.py`, `cli.py`, `autorun.py`
- `src/<package>/pipelines/{project_sync,introduce,log_drafter,now_updater,roadmap_sync}.py`
- `tools/dump-sitedata.mjs` — for bootstrapping from a JS-module content file

Files that need adapting per site:

- **`publish.py`** — the rendering function `render_sitedata_js` is JS-module-shaped. If the target site uses JSON/YAML/something else, replace it.
- **`bootstrap.py`** — pairs with `tools/dump-sitedata.mjs` for JS modules. Different format → different bootstrap.
- **Pipeline prompts** — the system prompts in `log_drafter.py`, `now_updater.py`, `introduce.py`, `roadmap_sync.py` encode the *voice* of the target site. Read 2-3 existing entries from the target's content file and adapt the prompts to match that voice. Don't ship the evergreenlabs voice verbatim to another site.
- **Schema fields** — the reference uses `profile`, `now`, `projects[]`, `roadmap[]`, `log[]`. If the target uses different field names, edit `drafts.py:load_site()` and `publish.py:render_sitedata_js`.

Files that may not apply:

- `roadmap_sync.py` only matters if the user has a Projects v2 board.
- `introduce.py` only matters if the target site has a `projects[]`-like section.
- `now_updater.py` only matters if the target has a "currently working on" surface.

Don't ship pipelines that don't fit the site. Trim before scaffolding.

## Bootstrap

After scaffolding:

1. `python3 -m venv .venv && .venv/bin/pip install -e .`
2. User fills in `.env`.
3. `bot bootstrap` — imports the current state of the site's content file into the new bot's `data/site/*.json`.
4. `bot sync-projects` — first no-LLM smoke test. Verifies GitHub creds work and the matched/unintroduced count makes sense.
5. `bot introduce` if there are unintroduced repos. Walk the review queue with the user.
6. `bot catch-up` for log entries.
7. `bot publish` writes back to the site.

## Scheduler

Pick one based on the user's platform:

- **Windows + WSL** — Windows Task Scheduler firing `wsl.exe bash -lc <script>`. Use `scripts/register-task.ps1` as the template. Fires even when WSL isn't open, which is the killer feature.
- **Linux with systemd** — user-level timer at `~/.config/systemd/user/site-bot.{service,timer}`. Simpler, but only fires when the machine is on and WSL/the user session is running.
- **macOS** — `launchd` agent at `~/Library/LaunchAgents/com.user.site-bot.plist`.

In all cases: the scheduled job runs `bot autorun`. The local LLM (LM Studio etc.) must be running when the job fires; otherwise `Connection refused` and the run fails. Make sure the user knows.

## Skill installation (if user wants this skill globally)

This skill ships inside the reference implementation's `.claude/skills/site-bot/` dir. To make it available outside that project, symlink:

```bash
ln -s <reference-repo>/.claude/skills/site-bot ~/.claude/skills/site-bot
```

Or copy. Symlink is better because it auto-tracks updates to the reference impl.

## Pitfalls observed in practice

- **Fine-grained PATs** don't grant Projects v2 access cleanly. Use classic PATs with `repo` + `read:project`.
- **Reasoning models (Gemma 4, Qwen 3.x)** burn 200-1500 tokens on chain-of-thought before producing actual output. `llm_client.py`'s `REASONING_OVERHEAD_TOKENS` constant handles this; raise it if completions come back empty with `finish_reason="length"`.
- **WSL networking**: localhost from WSL hits Windows's localhost only in mirrored-networking mode. Otherwise use the gateway IP. Test with `curl <base_url>/models` before debugging Python.
- **CRLF line endings** in `.env` written from Windows IDEs cause `invalid header field value for "Authorization"` errors. Strip with `sed -i 's/\r$//' .env`.
- **Voice drift** isn't a real risk if system prompts are stable; factual accuracy on commits is. Auto-accept is fine for log entries if you accept that occasional mis-reads will surface on the site until corrected on next run.

## When to refuse / redirect

- Site content sprawls across many files → this pattern doesn't fit; suggest consolidating first or building something different.
- User wants the bot to push directly without review *and* the LLM is small/fast — fine. But warn: the bot is only as good as its prompts and judgment. Review is the primary safety net.
- User asks for cloud deploy of the bot itself — out of scope for this skill. LM Studio is local; either change LLM provider or build a different system.

</what-to-do>
