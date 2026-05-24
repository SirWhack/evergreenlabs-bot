# evergreenlabs-bot

Local automation for the evergreenlabs website. Watches your public GitHub repos,
drafts log entries from logworthy commits via a local LLM, and writes the result
back into the website's `siteData.js`.

## Model

- **Canonical content** lives in `data/site/*.json` here (not in the website).
- The website's `src/content/siteData.js` is a generated artifact, rebuilt by
  `bot publish`.
- **Two paths:**
  - *Auto-sync* (no review): `bot sync-projects` updates `projects[]` metadata
    (stack, last-touched, repo link) directly from GitHub.
  - *Drafted* (review queue): `bot catch-up` pulls new commits since the last
    cursor, drafts log entries + `now.text` updates via the LLM, and drops them
    into `data/drafts/`. `bot review` walks the queue.

## Setup

```bash
cd /home/swynn/Code/evergreenlabs-bot
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
cp .env.example .env       # then fill in
bot bootstrap              # one-time: import current siteData.js into data/site/
```

## Daily use

```bash
bot catch-up               # fetch new commits, draft log entries + now.text
bot review                 # walk pending drafts (accept / edit / reject)
bot sync-projects          # refresh projects[] metadata from GitHub
bot publish                # regenerate siteData.js and (optionally) commit + push
```

`bot catch-up` is idempotent — running it after a week away processes
everything since the last cursor in one go.

## Reuse on another site

This repo ships a Claude Code skill at `.claude/skills/site-bot/` that
walks Claude through scaffolding the same pattern for a different site.
To make it globally available:

```bash
ln -s "$(pwd)/.claude/skills/site-bot" ~/.claude/skills/site-bot
```

Then `/site-bot` from any project Claude Code session.

## Files

```
src/evergreenlabs_bot/
  cli.py              entrypoint (bot ...)
  config.py           env loading
  github_client.py    repos + commits via GitHub REST
  llm_client.py       OpenAI-compatible client wrapping the local server
  state.py            sqlite: per-(repo, pipeline) cursors
  drafts.py           draft model + on-disk queue
  publish.py          JSON -> siteData.js + git
  review.py           interactive review TUI
  bootstrap.py        one-time siteData.js -> JSON import
  pipelines/
    project_sync.py
    log_drafter.py
    now_updater.py

data/
  site/               canonical JSON (committed)
  drafts/             pending drafts (gitignored)
  state.db            sqlite cursors (gitignored)
```
