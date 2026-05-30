#!/usr/bin/env npx tsx
// eval-voices.ts — Run real commits through multiple models × voice combos
// and produce a side-by-side comparison. No Workers deps; runs locally.
//
// Usage:
//   OPENROUTER_API_KEY=... DIFFUSION_KEY=... npx tsx scripts/eval-voices.ts
//
// Optional env:
//   EVAL_REPO     — repo name for the commit context (default: "evergreenlabs-bot")
//   EVAL_LIMIT    — max commits to pull from git log (default: 8)
//   EVAL_OUTPUT   — output file path (default: "eval-results.json")

import { execSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getVoice, type Voice } from "../src/lib/voices";

// Auto-load ../.env (repo root) so `npm run eval` works without manual sourcing
function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    // strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadDotenv(resolve(__dirname, "../../.env"));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const INCEPTION_URL = "https://api.inceptionlabs.ai/v1/chat/completions";

const MODELS = [
  { id: "anthropic/claude-haiku-4.5", label: "haiku", provider: "openrouter" as const },
  // { id: "mercury-2", label: "mercury-2", provider: "inception" as const },
];

const VOICE_OPTIONS: Voice[] = ["default", "chill"];

const REPO = process.env.EVAL_REPO || "evergreenlabs-bot";
const LIMIT = parseInt(process.env.EVAL_LIMIT || "8", 10);
const OUTPUT = process.env.EVAL_OUTPUT || "eval-results.json";

// ---------------------------------------------------------------------------
// Git commit extraction
// ---------------------------------------------------------------------------

interface LocalCommit {
  sha: string;
  message: string;
  files: string[];
  additions: number;
  deletions: number;
}

function getRecentCommits(limit: number): LocalCommit[] {
  const log = execSync(
    `git log --format="%H|||%s" -n ${limit}`,
    { encoding: "utf-8", cwd: process.cwd() },
  ).trim();

  if (!log) return [];

  return log.split("\n").map((line) => {
    const [sha, ...msgParts] = line.split("|||");
    const message = msgParts.join("|||");

    let files: string[] = [];
    let additions = 0;
    let deletions = 0;
    try {
      const stat = execSync(`git show --stat --format="" ${sha}`, {
        encoding: "utf-8",
        cwd: process.cwd(),
      }).trim();
      const statLines = stat.split("\n").filter(Boolean);
      const summaryLine = statLines[statLines.length - 1] || "";
      files = statLines.slice(0, -1).map((l) => l.trim().split(/\s+/)[0]);

      const addMatch = summaryLine.match(/(\d+) insertion/);
      const delMatch = summaryLine.match(/(\d+) deletion/);
      additions = addMatch ? parseInt(addMatch[1], 10) : 0;
      deletions = delMatch ? parseInt(delMatch[1], 10) : 0;
    } catch { /* non-fatal */ }

    return { sha: sha.slice(0, 8), message, files, additions, deletions };
  });
}

// ---------------------------------------------------------------------------
// LLM call (provider-agnostic)
// ---------------------------------------------------------------------------

interface CompletionResult {
  text: string;
  model: string;
  latencyMs: number;
}

async function complete(
  provider: "openrouter" | "inception",
  model: string,
  system: string,
  user: string,
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<CompletionResult> {
  const url = provider === "inception" ? INCEPTION_URL : OPENROUTER_URL;
  const apiKey = provider === "inception"
    ? process.env.DIFFUSION_KEY
    : process.env.OPENROUTER_API_KEY;

  if (!apiKey) throw new Error(`Missing API key for ${provider}`);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://github.com/SirWhack/evergreenlabs-bot";
    headers["X-Title"] = "evergreenlabs-bot-eval";
  }

  const start = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: opts.temperature ?? 0.5,
      max_tokens: opts.maxTokens ?? 300,
    }),
  });

  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`${provider} ${res.status}: ${errBody.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
  };
  const text = (data.choices?.[0]?.message?.content ?? "").trim();

  return { text, model: data.model ?? model, latencyMs };
}

// ---------------------------------------------------------------------------
// Eval runner
// ---------------------------------------------------------------------------

interface EvalRow {
  commit: { sha: string; message: string; files: string[]; additions: number; deletions: number };
  results: Array<{
    model: string;
    voice: Voice;
    draft: string;
    latencyMs: number;
  }>;
}

function formatFiles(files: string[]): string {
  if (!files.length) return "(none)";
  if (files.length <= 6) return files.join(", ");
  return files.slice(0, 6).join(", ") + `, … (+${files.length - 6} more)`;
}

function buildUserPrompt(commit: LocalCommit): string {
  return (
    `Project: ${REPO} (slug: ${REPO})\n` +
    `Commit message: ${commit.message}\n` +
    `Files: ${formatFiles(commit.files)}\n` +
    `Diff: +${commit.additions}/-${commit.deletions}\n\n` +
    `Write a log entry body (HTML allowed: <code>, <b>, <i>, <a>).\n`
  );
}

async function runEval(): Promise<void> {
  console.log(`\n🔬 eval-voices — ${MODELS.length} models × ${VOICE_OPTIONS.length} voices\n`);

  const commits = getRecentCommits(LIMIT);
  console.log(`found ${commits.length} commits to evaluate\n`);

  if (!commits.length) {
    console.log("no commits found — run from a git repo with history");
    return;
  }

  const rows: EvalRow[] = [];

  for (const commit of commits) {
    console.log(`--- ${commit.sha} ${commit.message.slice(0, 60)}`);
    const row: EvalRow = { commit, results: [] };
    const userPrompt = buildUserPrompt(commit);

    for (const model of MODELS) {
      for (const voice of VOICE_OPTIONS) {
        const system = getVoice("logDraft", voice);
        const tag = `  ${model.label}/${voice}`;
        try {
          const result = await complete(
            model.provider,
            model.id,
            system,
            userPrompt,
            { temperature: 0.5, maxTokens: 300 },
          );
          row.results.push({
            model: model.label,
            voice,
            draft: result.text,
            latencyMs: result.latencyMs,
          });
          console.log(`${tag}: ${result.latencyMs}ms — ${result.text.slice(0, 80)}…`);
        } catch (e: any) {
          console.log(`${tag}: ERROR — ${e?.message?.slice(0, 100)}`);
          row.results.push({
            model: model.label,
            voice,
            draft: `[ERROR] ${e?.message ?? e}`,
            latencyMs: 0,
          });
        }
      }
    }

    rows.push(row);
    console.log();
  }

  // Write JSON results
  writeFileSync(OUTPUT, JSON.stringify(rows, null, 2));
  console.log(`\n✅ wrote ${rows.length} eval rows to ${OUTPUT}`);

  // Print summary table
  printSummary(rows);
}

function printSummary(rows: EvalRow[]): void {
  console.log("\n" + "=".repeat(80));
  console.log("SUMMARY");
  console.log("=".repeat(80));

  const combos = MODELS.flatMap((m) =>
    VOICE_OPTIONS.map((v) => ({ model: m.label, voice: v })),
  );

  for (const { model, voice } of combos) {
    const results = rows
      .flatMap((r) => r.results)
      .filter((r) => r.model === model && r.voice === voice);
    const errors = results.filter((r) => r.draft.startsWith("[ERROR]")).length;
    const ok = results.filter((r) => !r.draft.startsWith("[ERROR]"));
    const avgLen = ok.length
      ? Math.round(ok.reduce((s, r) => s + r.draft.length, 0) / ok.length)
      : 0;
    const avgMs = ok.length
      ? Math.round(ok.reduce((s, r) => s + r.latencyMs, 0) / ok.length)
      : 0;

    console.log(
      `  ${model}/${voice}: ${ok.length} ok, ${errors} err | avg ${avgLen} chars, ${avgMs}ms`,
    );
  }

  console.log("\n" + "=".repeat(80));
  console.log("\nFull results in eval-results.json — review side-by-side:");
  console.log("  cat eval-results.json | jq '.[] | .commit.message, .results[].draft'");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runEval().catch((e) => {
  console.error("eval failed:", e);
  process.exit(1);
});
