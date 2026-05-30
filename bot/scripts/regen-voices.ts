#!/usr/bin/env npx tsx
// regen-voices.ts — One-shot script to regenerate all LLM-drafted content
// in remote D1 with the current voice prompts. Fetches original commit
// details from GitHub, re-drafts via OpenRouter, writes back to D1.
//
// Usage:
//   npx tsx scripts/regen-voices.ts
//
// Requires .env with: OPENROUTER_API_KEY, GITHUB_TOKEN, GITHUB_USERNAME
//
// Optional:  --dry-run   (show what would change without writing to D1)

import { execSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { getVoice } from "../src/lib/voices";

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadDotenv(resolve(__dirname, "../../.env"));

const DRY_RUN = process.argv.includes("--dry-run");
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const GITHUB_API = "https://api.github.com";
const USERNAME = process.env.GITHUB_USERNAME || "SirWhack";

// ---------------------------------------------------------------------------
// D1 via wrangler CLI
// ---------------------------------------------------------------------------

const WRANGLER = resolve(__dirname, "../node_modules/.bin/wrangler");
const D1_OPTS = { encoding: "utf-8" as const, cwd: resolve(__dirname, "..") };

function d1Query(sql: string): any[] {
  const escaped = sql.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
  const raw = execSync(
    `${WRANGLER} d1 execute evergreenlabs-bot --remote --command "${escaped}" --json`,
    D1_OPTS,
  );
  const jsonStart = raw.indexOf("[");
  if (jsonStart === -1) throw new Error(`No JSON in wrangler output: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(raw.slice(jsonStart));
  return parsed[0]?.results ?? [];
}

function d1Exec(sql: string): void {
  const tmpFile = resolve(tmpdir(), `regen-exec-${Date.now()}.sql`);
  writeFileSync(tmpFile, sql);
  try {
    execSync(
      `${WRANGLER} d1 execute evergreenlabs-bot --remote --file "${tmpFile}"`,
      { ...D1_OPTS, stdio: "pipe" },
    );
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

function sqlEscape(val: string): string {
  return val.replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// GitHub API
// ---------------------------------------------------------------------------

async function ghFetch(path: string): Promise<any> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "evergreenlabs-bot-regen",
    },
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${path}`);
  return res.json();
}

interface CommitDetail {
  sha: string;
  repo: string;
  message: string;
  filesChanged: string[];
  additions: number;
  deletions: number;
}

async function fetchCommit(repoShort: string, sha: string): Promise<CommitDetail> {
  const fullName = `${USERNAME}/${repoShort}`;
  const raw = await ghFetch(`/repos/${fullName}/commits/${sha}`);
  return {
    sha: raw.sha,
    repo: repoShort,
    message: (raw.commit?.message ?? "").trim(),
    filesChanged: (raw.files ?? []).slice(0, 50).map((f: any) => f.filename),
    additions: raw.stats?.additions ?? 0,
    deletions: raw.stats?.deletions ?? 0,
  };
}

async function fetchRepoInfo(repoShort: string): Promise<{ description: string; language: string; topics: string[]; readme: string }> {
  const fullName = `${USERNAME}/${repoShort}`;
  const repo = await ghFetch(`/repos/${fullName}`);
  let readme = "";
  try {
    const readmeRes = await ghFetch(`/repos/${fullName}/readme`);
    if (readmeRes.content) {
      readme = Buffer.from(readmeRes.content, "base64").toString("utf-8");
    }
  } catch { /* no readme */ }
  return {
    description: repo.description || "",
    language: repo.language || "",
    topics: repo.topics || [],
    readme,
  };
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

async function llmChat(system: string, user: string, opts: { temperature?: number; maxTokens?: number } = {}): Promise<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/SirWhack/evergreenlabs-bot",
      "X-Title": "evergreenlabs-bot-regen",
    },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4.5",
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: opts.temperature ?? 0.5,
      max_tokens: opts.maxTokens ?? 300,
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as any;
  let text = (data.choices?.[0]?.message?.content ?? "").trim();
  if (text.startsWith("```")) {
    text = text.replace(/^```[a-z]*\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  }
  text = text.replace(/^"+|"+$/g, "").trim();
  return text;
}

// ---------------------------------------------------------------------------
// Regenerators
// ---------------------------------------------------------------------------

function formatFiles(files: string[]): string {
  if (!files.length) return "(none)";
  if (files.length <= 6) return files.join(", ");
  return files.slice(0, 6).join(", ") + `, … (+${files.length - 6} more)`;
}

function readmeExcerpt(text: string, n = 400): string {
  if (!text) return "(no README)";
  const lines = text.split("\n").filter((ln) => {
    const t = ln.trim();
    return t && !t.startsWith("#") && !t.startsWith("![") && !t.startsWith("<!--");
  });
  const body = lines.join(" ");
  return body.length > n ? body.slice(0, n) + "…" : body;
}

async function regenLogEntry(draft: any): Promise<string> {
  const commits: string[] = JSON.parse(draft.source_commits);
  if (!commits.length) return "";

  const commit = await fetchCommit(draft.source_repo, commits[0]);
  const user =
    `Project: ${commit.repo} (slug: ${commit.repo})\n` +
    `Commit message: ${commit.message}\n` +
    `Files: ${formatFiles(commit.filesChanged)}\n` +
    `Diff: +${commit.additions}/-${commit.deletions}\n\n` +
    `Write a log entry body (HTML allowed: <code>, <b>, <i>, <a>).\n`;

  return llmChat(getVoice("logDraft", "chill"), user, { temperature: 0.5, maxTokens: 300 });
}

async function regenProjectBlurb(draft: any): Promise<string> {
  const payload = JSON.parse(draft.payload);
  const repoShort = draft.source_repo || payload.slug || payload.title;
  const info = await fetchRepoInfo(repoShort);

  const user =
    `Repo: ${repoShort}\n` +
    `Language: ${info.language || "(unknown)"}\n` +
    `Topics: ${info.topics.join(", ") || "(none)"}\n` +
    `GitHub description: ${info.description || "(none)"}\n\n` +
    `README (first ~400 chars):\n${readmeExcerpt(info.readme)}\n\n` +
    `Write the blurb (1-2 short sentences, or empty if you don't have enough).`;

  return llmChat(getVoice("blurb", "chill"), user, { temperature: 0.4, maxTokens: 200 });
}

async function regenNowText(draft: any): Promise<string> {
  const payload = JSON.parse(draft.payload);
  // Get the most recent log entry for context
  const logRows = d1Query("SELECT payload FROM site_parts WHERE name = 'log'");
  const log = logRows.length ? JSON.parse(logRows[0].payload) : [];
  const latest = log[0];
  if (!latest) return payload.text; // can't regen without context

  const projectsRows = d1Query("SELECT payload FROM site_parts WHERE name = 'projects'");
  const projects = projectsRows.length ? JSON.parse(projectsRows[0].payload) : [];
  const slug = latest.project;
  const project = projects.find((p: any) => p.slug?.toLowerCase() === slug?.toLowerCase());

  const user =
    `The user just accepted a log entry. Forward-rephrase it as a "currently\n` +
    `working on" status — same project, present tense, looking ahead at the next\n` +
    `step. Do NOT quote the log entry verbatim.\n\n` +
    `Project: ${project?.title ?? slug ?? "unknown"}\n` +
    `Project blurb: ${project?.blurb ?? "(none)"}\n` +
    `Log entry body: ${latest.body ?? ""}\n\n` +
    `Write the now.text body.`;

  return llmChat(getVoice("now", "chill"), user, { temperature: 0.5, maxTokens: 200 });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n${DRY_RUN ? "🔍 DRY RUN" : "🔄 REGENERATING"} — chill voice, haiku\n`);

  // --- Log entries ---
  const logDrafts = d1Query("SELECT id, source_repo, source_commits, payload FROM drafts WHERE kind = 'log_entry' AND status = 'accepted'");
  console.log(`📝 log entries: ${logDrafts.length}`);

  for (const draft of logDrafts) {
    const payload = JSON.parse(draft.payload);
    const oldBody = payload.body;
    try {
      const newBody = await regenLogEntry(draft);
      if (!newBody || newBody.length < 20) {
        console.log(`  ⏭️  ${draft.id.slice(0, 8)} — new body too short, skipping`);
        continue;
      }
      console.log(`  ✅ ${draft.id.slice(0, 8)} [${draft.source_repo}]`);
      console.log(`     old: ${oldBody.slice(0, 80)}…`);
      console.log(`     new: ${newBody.slice(0, 80)}…`);

      if (!DRY_RUN) {
        payload.body = newBody;
        d1Exec(`UPDATE drafts SET payload = '${sqlEscape(JSON.stringify(payload))}' WHERE id = '${draft.id}'`);
      }
    } catch (e: any) {
      console.log(`  ❌ ${draft.id.slice(0, 8)} — ${e?.message?.slice(0, 80)}`);
    }
  }

  // --- Project intros ---
  const introDrafts = d1Query("SELECT id, source_repo, payload FROM drafts WHERE kind = 'project_intro' AND status = 'accepted'");
  console.log(`\n🏗️  project intros: ${introDrafts.length}`);

  for (const draft of introDrafts) {
    const payload = JSON.parse(draft.payload);
    const oldBlurb = payload.blurb;
    try {
      const newBlurb = await regenProjectBlurb(draft);
      if (!newBlurb) {
        console.log(`  ⏭️  ${draft.id.slice(0, 8)} — empty blurb, skipping`);
        continue;
      }
      console.log(`  ✅ ${draft.id.slice(0, 8)} [${draft.source_repo}]`);
      console.log(`     old: ${oldBlurb.slice(0, 80)}…`);
      console.log(`     new: ${newBlurb.slice(0, 80)}…`);

      if (!DRY_RUN) {
        payload.blurb = newBlurb;
        d1Exec(`UPDATE drafts SET payload = '${sqlEscape(JSON.stringify(payload))}' WHERE id = '${draft.id}'`);
      }
    } catch (e: any) {
      console.log(`  ❌ ${draft.id.slice(0, 8)} — ${e?.message?.slice(0, 80)}`);
    }
  }

  // --- Rebuild site_parts from updated drafts ---
  if (!DRY_RUN) {
    console.log("\n📦 rebuilding site_parts from updated drafts...");

    // Rebuild log
    const allLogDrafts = d1Query("SELECT payload FROM drafts WHERE kind = 'log_entry' AND status = 'accepted' ORDER BY created_at DESC");
    const newLog = allLogDrafts.map((d: any) => JSON.parse(d.payload));
    d1Exec(`UPDATE site_parts SET payload = '${sqlEscape(JSON.stringify(newLog))}', updated_at = ${Math.floor(Date.now() / 1000)} WHERE name = 'log'`);
    console.log(`  ✅ site_parts.log — ${newLog.length} entries`);

    // Rebuild projects
    const allIntroDrafts = d1Query("SELECT payload FROM drafts WHERE kind = 'project_intro' AND status = 'accepted'");
    // Merge blurbs into existing projects (don't overwrite non-blurb fields that project_sync maintains)
    const existingProjects: any[] = JSON.parse(d1Query("SELECT payload FROM site_parts WHERE name = 'projects'")[0]?.payload ?? "[]");
    for (const draft of allIntroDrafts) {
      const introPayload = JSON.parse(draft.payload);
      const match = existingProjects.find((p: any) => p.slug?.toLowerCase() === introPayload.slug?.toLowerCase());
      if (match) {
        match.blurb = introPayload.blurb;
      }
    }
    d1Exec(`UPDATE site_parts SET payload = '${sqlEscape(JSON.stringify(existingProjects))}', updated_at = ${Math.floor(Date.now() / 1000)} WHERE name = 'projects'`);
    console.log(`  ✅ site_parts.projects — ${existingProjects.length} entries`);

    // Regen now text (just one, based on latest log)
    console.log("\n⏰ regenerating now text...");
    const nowDrafts = d1Query("SELECT id, payload FROM drafts WHERE kind = 'now_text' AND status = 'accepted' ORDER BY created_at DESC LIMIT 1");
    if (nowDrafts.length) {
      try {
        const newNowText = await regenNowText(nowDrafts[0]);
        if (newNowText && newNowText.length >= 10) {
          const nowPayload = JSON.parse(nowDrafts[0].payload);
          nowPayload.text = newNowText;
          console.log(`  ✅ now text: ${newNowText.slice(0, 80)}…`);
          d1Exec(`UPDATE site_parts SET payload = '${sqlEscape(JSON.stringify(nowPayload))}', updated_at = ${Math.floor(Date.now() / 1000)} WHERE name = 'now'`);
        }
      } catch (e: any) {
        console.log(`  ❌ now text — ${e?.message?.slice(0, 80)}`);
      }
    }
  }

  // --- Trigger publish ---
  if (!DRY_RUN) {
    console.log("\n🚀 triggering daily-sync to publish...");
    const triggerToken = process.env.TRIGGER_TOKEN;
    const res = await fetch("https://evergreenlabs-bot.swynnr.workers.dev/trigger/daily-sync", {
      method: "POST",
      headers: { Authorization: `Bearer ${triggerToken}` },
    });
    const body = await res.json() as any;
    console.log(`  workflow: ${body.id}`);
  }

  console.log("\n✅ done\n");
}

main().catch((e) => {
  console.error("regen failed:", e);
  process.exit(1);
});
