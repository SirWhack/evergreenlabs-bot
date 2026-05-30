#!/usr/bin/env npx tsx
// spike-board-setup.ts — READ-ONLY preflight for ADR-0003.
//
// Verifies the GitHub side is configured before deploying the cross-repo
// issue board. Makes no mutations — safe to run repeatedly.
//
//   npm run spike:board          (from bot/)
//   npx tsx scripts/spike-board-setup.ts
//
// Reads secrets from ../.env (PAT + App creds) and the board owner/number
// from wrangler.toml [vars] — i.e. exactly what the deployed Worker will use.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAppMetadata, getInstallationToken, type GhAppEnv } from "../src/lib/github";

// --- env loading (mirrors scripts/eval-voices.ts) --------------------------

// Multi-line aware: handles a double-quoted value spanning lines (the PEM
// private key) as well as plain single-line KEY=value.
function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf-8");
  const re = /^([A-Z0-9_]+)=(?:"([\s\S]*?)"|'([\s\S]*?)'|([^\n]*))/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    if (!process.env[key]) process.env[key] = val;
  }
}

/** Pull a [vars] value out of wrangler.toml — source of truth for deploy. */
function wranglerVar(toml: string, key: string): string | null {
  const m = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return m ? m[1] : null;
}

loadDotenv(resolve(__dirname, "../../.env"));
const wrangler = readFileSync(resolve(__dirname, "../wrangler.toml"), "utf-8");

// wrangler.toml [vars] is the deploy source of truth — prefer it over any
// stale value mirrored into .env for local tooling.
const OWNER = wranglerVar(wrangler, "GITHUB_PROJECT_OWNER") || process.env.GITHUB_PROJECT_OWNER || "";
const NUMBER = parseInt(
  wranglerVar(wrangler, "GITHUB_PROJECT_NUMBER") || process.env.GITHUB_PROJECT_NUMBER || "0",
  10,
);
const USERNAME = wranglerVar(wrangler, "GITHUB_USERNAME") || process.env.GITHUB_USERNAME || "";
const PAT = process.env.GITHUB_PAT_PROJECTS || "";

// Locally, .env may hold a *path* to the .pem rather than the key itself
// (in production the secret holds the real PEM). Resolve the path if so.
function resolvePrivateKey(raw: string): string {
  if (!raw || raw.includes("BEGIN")) return raw;
  const rel = raw.replace(/^\.[\\/]/, "").replace(/\\/g, "/");
  const abs = resolve(__dirname, "../../", rel);
  return existsSync(abs) ? readFileSync(abs, "utf-8") : raw;
}

const appEnv: GhAppEnv = {
  GITHUB_APP_ID: process.env.GITHUB_APP_ID || "",
  GITHUB_APP_INSTALLATION_ID: process.env.GITHUB_APP_INSTALLATION_ID || "",
  GITHUB_APP_PRIVATE_KEY: resolvePrivateKey(process.env.GITHUB_APP_PRIVATE_KEY || ""),
};

const EXPECTED_STATUSES = ["todo", "in progress", "done", "won't do"];

// --- tiny check harness ----------------------------------------------------

let failures = 0;
let warnings = 0;
const pass = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m: string) => { failures++; console.log(`  \x1b[31m✗\x1b[0m ${m}`); };
const warn = (m: string) => { warnings++; console.log(`  \x1b[33m!\x1b[0m ${m}`); };
const head = (m: string) => console.log(`\n\x1b[1m${m}\x1b[0m`);

async function patGraphQL<T>(query: string, variables: Record<string, unknown>): Promise<{ data?: T; errors?: Array<{ message: string }>; status: number }> {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${PAT}`,
      "Content-Type": "application/json",
      "User-Agent": "evergreenlabs-bot-spike",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json().catch(() => ({}))) as { data?: T; errors?: Array<{ message: string }> };
  return { ...body, status: res.status };
}

// --- checks ----------------------------------------------------------------

async function checkConfigPresent(): Promise<void> {
  head("0. Local config");
  console.log(`    owner=${OWNER || "(unset)"}  project=#${NUMBER || "(unset)"}  user=${USERNAME || "(unset)"}`);
  OWNER ? pass("GITHUB_PROJECT_OWNER set") : fail("GITHUB_PROJECT_OWNER missing (wrangler.toml [vars])");
  NUMBER ? pass(`GITHUB_PROJECT_NUMBER = ${NUMBER}`) : fail("GITHUB_PROJECT_NUMBER missing/zero");
  PAT ? pass("GITHUB_PAT_PROJECTS present in .env") : fail("GITHUB_PAT_PROJECTS missing from .env");
  appEnv.GITHUB_APP_PRIVATE_KEY ? pass("App credentials present in .env") : fail("App credentials missing from .env");
}

async function checkPatReachesBoard(): Promise<void> {
  head("1. PAT → org board + Status options");
  if (!PAT || !OWNER || !NUMBER) return fail("skipped — missing config above");

  const q = `query($login:String!,$number:Int!){
    organization(login:$login){ projectV2(number:$number){
      id title url
      fields(first:50){ nodes{ __typename ... on ProjectV2SingleSelectField { name options { name } } } }
    } }
  }`;
  const r = await patGraphQL<{ organization: { projectV2: { title: string; url: string; fields: { nodes: Array<{ __typename: string; name?: string; options?: Array<{ name: string }> }> } } | null } | null }>(q, { login: OWNER, number: NUMBER });

  if (r.status === 401) return fail("PAT rejected (401) — token invalid or expired");
  if (r.errors?.length) {
    const msg = r.errors[0].message;
    fail(`board query errored: ${msg}`);
    if (/not have permission|resource not accessible|scope/i.test(msg)) {
      warn("Looks like a PAT scope / org-policy issue. Give the PAT `project` (classic) or Projects:R/W (fine-grained), and allow it under EvergreenLabs-US → Settings → Third-party Access → Personal access tokens.");
    }
    return;
  }
  const org = r.data?.organization;
  if (!org) return fail(`org "${OWNER}" not visible to this PAT (org-policy may be blocking the token)`);
  const proj = org.projectV2;
  if (!proj) return fail(`project #${NUMBER} not found under ${OWNER} — wrong number?`);
  pass(`reached board: "${proj.title}" (${proj.url})`);

  const status = proj.fields.nodes.find((n) => n.name?.toLowerCase() === "status" && n.__typename === "ProjectV2SingleSelectField");
  if (!status) return fail('no single-select "Status" field on the board');
  const have = (status.options ?? []).map((o) => o.name.toLowerCase());
  const missing = EXPECTED_STATUSES.filter((s) => !have.includes(s));
  const extra = have.filter((s) => !EXPECTED_STATUSES.includes(s));
  if (missing.length === 0) pass(`Status options present: ${(status.options ?? []).map((o) => o.name).join(", ")}`);
  else fail(`Status missing required options: ${missing.join(", ")} (have: ${have.join(", ") || "none"})`);
  if (extra.length) warn(`Status has extra options not in the lifecycle: ${extra.join(", ")} (reconcile leaves these alone, but won't drive them)`);
}

async function checkPatSeesUserIssues(): Promise<void> {
  head("2. PAT can resolve a user-repo issue (cross-account add prerequisite)");
  if (!PAT || !USERNAME) return fail("skipped — missing PAT/username");

  // Find any one issue across the user's repos via REST (PAT, repo scope).
  const reposRes = await fetch(`https://api.github.com/users/${USERNAME}/repos?per_page=100&type=owner&sort=pushed`, {
    headers: { Authorization: `Bearer ${PAT}`, "User-Agent": "evergreenlabs-bot-spike", Accept: "application/vnd.github+json" },
  });
  if (!reposRes.ok) return fail(`listing ${USERNAME} repos with PAT failed: ${reposRes.status} (PAT may lack repo scope)`);
  const repos = (await reposRes.json()) as Array<{ full_name: string; open_issues_count: number; archived: boolean; fork: boolean }>;
  // open_issues_count includes PRs, so scan candidates until we find a real
  // issue. Bound the API calls to the 8 busiest repos.
  const candidates = repos
    .filter((r) => !r.archived && !r.fork && r.open_issues_count > 0)
    .sort((a, b) => b.open_issues_count - a.open_issues_count)
    .slice(0, 8);
  if (candidates.length === 0) return warn("no open issues found in any repo to test with — open one issue and re-run to fully verify cross-account add");

  let found: { repo: string; number: number; node_id: string } | null = null;
  for (const c of candidates) {
    const res = await fetch(`https://api.github.com/repos/${c.full_name}/issues?state=all&per_page=20`, {
      headers: { Authorization: `Bearer ${PAT}`, "User-Agent": "evergreenlabs-bot-spike", Accept: "application/vnd.github+json" },
    });
    if (!res.ok) continue;
    const issues = (await res.json()) as Array<{ node_id: string; number: number; pull_request?: unknown }>;
    const issue = issues.find((i) => !i.pull_request);
    if (issue) { found = { repo: c.full_name, number: issue.number, node_id: issue.node_id }; break; }
  }
  if (!found) return warn("scanned the busiest repos but found only PRs — open a plain issue and re-run to fully verify cross-account add");

  // The real test: can the PAT resolve that issue's node? If yes,
  // addProjectV2ItemById(projectId, contentId=node) will work across accounts.
  const r = await patGraphQL<{ node: { __typename: string; number?: number } | null }>(
    `query($id:ID!){ node(id:$id){ __typename ... on Issue { number } } }`,
    { id: found.node_id },
  );
  if (r.errors?.length) return fail(`PAT could not resolve user-repo issue node: ${r.errors[0].message}`);
  if (r.data?.node?.__typename === "Issue") {
    pass(`PAT resolved ${found.repo}#${found.number} — cross-account add will work`);
  } else {
    fail("PAT could not see the user-repo issue — it can't add user issues to the org board (give the PAT repo access)");
  }
}

async function checkAppPermsAndEvents(): Promise<void> {
  head("3. GitHub App: issues permission + webhook subscription");
  if (!appEnv.GITHUB_APP_PRIVATE_KEY) return fail("skipped — App creds missing");

  let meta;
  try {
    meta = await getAppMetadata(appEnv);
  } catch (e) {
    return fail(`could not auth as the App: ${e instanceof Error ? e.message : String(e)}`);
  }
  pass(`authenticated as App "${meta.slug}"`);

  const issuesPerm = meta.permissions.issues;
  if (issuesPerm === "write") pass("App declares Issues: write");
  else fail(`App Issues permission is "${issuesPerm ?? "none"}" — set it to Read & write`);

  if (meta.events.includes("issues")) pass("App is subscribed to the `issues` webhook event");
  else fail(`App not subscribed to \`issues\` (events: ${meta.events.join(", ") || "none"})`);

  warn("If you changed the App's permissions recently, accept them on the installation page or the installation token keeps the old scope (~1h).");

  // Confirm the installation token actually mints (covers private-key + install id).
  try {
    await getInstallationToken(appEnv);
    pass("installation token mints OK");
  } catch (e) {
    fail(`installation token failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- run -------------------------------------------------------------------

(async () => {
  console.log("\x1b[1mADR-0003 board setup preflight (read-only)\x1b[0m");
  await checkConfigPresent();
  await checkPatReachesBoard();
  await checkPatSeesUserIssues();
  await checkAppPermsAndEvents();

  console.log("");
  if (failures === 0) {
    console.log(`\x1b[32m\x1b[1mAll checks passed\x1b[0m${warnings ? ` (${warnings} warning${warnings > 1 ? "s" : ""})` : ""}. Safe to migrate + deploy.`);
    process.exit(0);
  } else {
    console.log(`\x1b[31m\x1b[1m${failures} check${failures > 1 ? "s" : ""} failed\x1b[0m${warnings ? `, ${warnings} warning${warnings > 1 ? "s" : ""}` : ""}. Fix the ✗ items above, then re-run.`);
    process.exit(1);
  }
})();
