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
