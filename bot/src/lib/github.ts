// GitHub App authentication + minimal REST client, implemented entirely
// with Web Crypto. We deliberately avoid @octokit/auth-app and friends:
// (1) one fewer dependency surface, (2) RS256 + a single REST call is trivial
// to do with `crypto.subtle`, (3) keeps the cold-start small. `nodejs_compat`
// is still on in wrangler.toml so swapping to Octokit later is a one-liner.
//
// Auth flow per GitHub docs:
//   1. Build a JWT signed with the App's RSA private key (iss=app_id, exp<=10m)
//   2. POST /app/installations/{installation_id}/access_tokens with that JWT
//   3. Use the returned `token` as a Bearer for repo-scoped REST calls
//
// Installation tokens last ~1 hour; we cache in module scope and refresh
// ~5 minutes before expiry.

export interface GhAppEnv {
  GITHUB_APP_ID: string;
  GITHUB_APP_INSTALLATION_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
}

interface CachedToken {
  token: string;
  /** UNIX epoch seconds at which we should treat the token as expired. */
  expiresAt: number;
}

let cached: CachedToken | null = null;

const REFRESH_MARGIN_SECONDS = 5 * 60;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function base64UrlEncode(input: ArrayBuffer | Uint8Array | string): string {
  let bytes: Uint8Array;
  if (typeof input === "string") {
    bytes = new TextEncoder().encode(input);
  } else if (input instanceof Uint8Array) {
    bytes = input;
  } else {
    bytes = new Uint8Array(input);
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Decode a PEM PKCS#8 RSA private key into raw DER bytes for crypto.subtle.
 * GitHub App private keys are PKCS#1 by default; many users convert to PKCS#8
 * (BEGIN PRIVATE KEY) before pasting into wrangler secret. We support both
 * formats: PKCS#8 is consumed directly, PKCS#1 is wrapped into PKCS#8.
 */
function pemToPkcs8Der(pem: string): Uint8Array {
  const trimmed = pem.trim();
  const pkcs8Match = trimmed.match(
    /-----BEGIN PRIVATE KEY-----([\s\S]+?)-----END PRIVATE KEY-----/,
  );
  if (pkcs8Match) {
    return base64Decode(pkcs8Match[1].replace(/\s+/g, ""));
  }
  const pkcs1Match = trimmed.match(
    /-----BEGIN RSA PRIVATE KEY-----([\s\S]+?)-----END RSA PRIVATE KEY-----/,
  );
  if (pkcs1Match) {
    const pkcs1 = base64Decode(pkcs1Match[1].replace(/\s+/g, ""));
    return wrapPkcs1AsPkcs8(pkcs1);
  }
  throw new Error("GITHUB_APP_PRIVATE_KEY: unrecognized PEM format");
}

function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Wrap a PKCS#1 RSAPrivateKey blob (BEGIN RSA PRIVATE KEY) inside a PKCS#8
 * PrivateKeyInfo envelope so crypto.subtle.importKey('pkcs8', ...) accepts it.
 *
 * DER prefix is fixed: SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL },
 *                                  OCTET STRING <pkcs1> }
 */
function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  // The fixed prefix below is the DER encoding of:
  //   SEQUENCE
  //     INTEGER 0
  //     SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
  //     OCTET STRING (... PKCS#1 body here ...)
  // We then append a length-prefixed OCTET STRING containing pkcs1.
  const prefix = new Uint8Array([
    0x30, 0x82, 0x00, 0x00, // SEQUENCE, length placeholder (filled below)
    0x02, 0x01, 0x00, // INTEGER 0
    0x30, 0x0d, // SEQUENCE (13 bytes)
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, // rsaEncryption OID
    0x05, 0x00, // NULL
    0x04, 0x82, 0x00, 0x00, // OCTET STRING, length placeholder (filled below)
  ]);

  // Fill OCTET STRING length (bytes 24..25 of prefix)
  const pkcs1Len = pkcs1.length;
  prefix[prefix.length - 2] = (pkcs1Len >> 8) & 0xff;
  prefix[prefix.length - 1] = pkcs1Len & 0xff;

  // Total inner length = (everything after the outer SEQUENCE header)
  const innerLen = prefix.length - 4 + pkcs1Len;
  prefix[2] = (innerLen >> 8) & 0xff;
  prefix[3] = innerLen & 0xff;

  const out = new Uint8Array(prefix.length + pkcs1.length);
  out.set(prefix, 0);
  out.set(pkcs1, prefix.length);
  return out;
}

async function signAppJwt(env: GhAppEnv): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const iat = nowSeconds() - 30; // clock skew buffer
  const payload = {
    iat,
    exp: iat + 9 * 60, // GH max is 10 min
    iss: env.GITHUB_APP_ID,
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(payload),
  )}`;

  // Wrangler secret values may have literal \n escape sequences; normalize.
  const pem = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n");
  const keyDer = pemToPkcs8Der(pem);
  const key = await crypto.subtle.importKey(
    "pkcs8",
    keyDer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(sig)}`;
}

async function fetchInstallationToken(env: GhAppEnv): Promise<CachedToken> {
  const jwt = await signAppJwt(env);
  const res = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "evergreenlabs-bot",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!res.ok) {
    throw new Error(
      `GitHub installation token request failed: ${res.status} ${await res.text()}`,
    );
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  const expiresAt = Math.floor(new Date(body.expires_at).getTime() / 1000);
  return { token: body.token, expiresAt };
}

export async function getInstallationToken(env: GhAppEnv): Promise<string> {
  if (cached && cached.expiresAt - REFRESH_MARGIN_SECONDS > nowSeconds()) {
    return cached.token;
  }
  cached = await fetchInstallationToken(env);
  return cached.token;
}

/** Thin authenticated wrapper around fetch() for the REST API. */
export async function ghFetch(
  env: GhAppEnv,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getInstallationToken(env);
  const url = path.startsWith("http") ? path : `https://api.github.com${path}`;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("User-Agent", "evergreenlabs-bot");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  return fetch(url, { ...init, headers });
}

/**
 * Mirrors the Python `Commit` dataclass — the shape `log_drafter` prompts
 * expect. Built from a `GET /repos/{owner}/{repo}/commits/{sha}` response.
 */
export interface CommitDetail {
  sha: string;
  repo: string;
  message: string;
  authorLogin: string | null;
  authorEmail: string | null;
  authorName: string | null;
  date: string; // ISO
  url: string;
  filesChanged: string[];
  additions: number;
  deletions: number;
}

/**
 * Fetch the per-commit detail blob (stats + file list) for a single SHA.
 * The push webhook payload's `commits[]` only contains message + author +
 * touched-paths arrays; it does not include +/- counts. We need those for
 * the judge prompt, so this round-trips one GET per commit.
 *
 * `repoFullName` is `owner/name`; `repoShortName` is what we record on the
 * Commit (matches Python `repo` field).
 */
export async function fetchCommitDetail(
  env: GhAppEnv,
  repoFullName: string,
  repoShortName: string,
  sha: string,
): Promise<CommitDetail> {
  const res = await ghFetch(env, `/repos/${repoFullName}/commits/${sha}`);
  if (!res.ok) {
    throw new Error(
      `github: GET commit ${repoFullName}@${sha} failed ${res.status} ${await res.text()}`,
    );
  }
  const raw = (await res.json()) as {
    sha: string;
    html_url: string;
    author?: { login?: string } | null;
    commit: {
      message: string;
      author?: { name?: string; email?: string; date?: string };
      committer?: { date?: string };
    };
    files?: Array<{ filename: string }>;
    stats?: { additions?: number; deletions?: number };
  };
  const files = (raw.files ?? []).slice(0, 50).map((f) => f.filename);
  const dateStr =
    raw.commit.author?.date ?? raw.commit.committer?.date ?? new Date().toISOString();
  return {
    sha: raw.sha,
    repo: repoShortName,
    message: (raw.commit.message ?? "").trim(),
    authorLogin: raw.author?.login ?? null,
    authorEmail: raw.commit.author?.email ?? null,
    authorName: raw.commit.author?.name ?? null,
    date: dateStr,
    url: raw.html_url,
    filesChanged: files,
    additions: raw.stats?.additions ?? 0,
    deletions: raw.stats?.deletions ?? 0,
  };
}

/**
 * Fetch the raw README content for a repository. Returns the text on success,
 * or null if the repo has no README (404). Uses the "raw" media type so the
 * response body is plain text rather than Base64-encoded JSON.
 */
export async function fetchReadme(
  env: GhAppEnv,
  repoFullName: string,
): Promise<string | null> {
  const res = await ghFetch(env, `/repos/${repoFullName}/readme`, {
    headers: { Accept: "application/vnd.github.raw" },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      `fetchReadme: ${repoFullName} returned ${res.status} ${await res.text()}`,
    );
  }
  return res.text();
}

/**
 * Parse a GitHub Link header to extract the rel="next" URL, or null if absent.
 * Format example:
 *   <https://api.github.com/...?page=2>; rel="next", <...?page=5>; rel="last"
 */
function parseNextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/** Minimal repo metadata we care about for project_sync — mirrors Python `Repo`. */
export interface GhRepo {
  name: string;
  full_name: string;
  description: string | null;
  html_url: string;
  default_branch: string;
  /** ISO-8601 string (e.g. "2026-05-20T12:34:56Z"). */
  pushed_at: string;
  archived: boolean;
  fork: boolean;
  language: string | null;
  topics: string[];
}

/**
 * List the configured user's public repositories, App-authenticated.
 * Mirrors Python `GitHubClient.list_public_repos`:
 *   GET /users/{username}/repos?type=owner&sort=pushed&per_page=100
 * Follows `Link: rel="next"` pagination.
 */
export async function listPublicRepos(
  env: GhAppEnv,
  username: string,
): Promise<GhRepo[]> {
  let url: string | null =
    `https://api.github.com/users/${encodeURIComponent(username)}/repos` +
    `?type=owner&sort=pushed&per_page=100`;
  const out: GhRepo[] = [];
  while (url) {
    const res: Response = await ghFetch(env, url);
    if (!res.ok) {
      throw new Error(
        `listPublicRepos: ${res.status} ${await res.text()}`,
      );
    }
    const page = (await res.json()) as Array<Record<string, unknown>>;
    for (const raw of page) {
      out.push({
        name: String(raw.name),
        full_name: String(raw.full_name),
        description: (raw.description ?? null) as string | null,
        html_url: String(raw.html_url),
        default_branch: String(raw.default_branch ?? "main"),
        pushed_at: String(raw.pushed_at),
        archived: Boolean(raw.archived),
        fork: Boolean(raw.fork),
        language: (raw.language ?? null) as string | null,
        topics: Array.isArray(raw.topics) ? (raw.topics as string[]) : [],
      });
    }
    url = parseNextLink(res.headers.get("Link"));
  }
  return out;
}
