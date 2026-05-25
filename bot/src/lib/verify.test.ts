import { describe, it, expect } from "vitest";
import { verifyGitHubSignature } from "./verify";

async function sign(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

describe("verifyGitHubSignature", () => {
  const secret = "test-secret-key";
  const body = '{"action":"push"}';

  it("accepts a valid signature", async () => {
    const sig = await sign(secret, body);
    expect(await verifyGitHubSignature(secret, body, sig)).toBe(true);
  });

  it("rejects a wrong signature", async () => {
    const sig = await sign(secret, body);
    const bad = sig.slice(0, -2) + "ff";
    expect(await verifyGitHubSignature(secret, body, bad)).toBe(false);
  });

  it("rejects a wrong secret", async () => {
    const sig = await sign("wrong-secret", body);
    expect(await verifyGitHubSignature(secret, body, sig)).toBe(false);
  });

  it("rejects a wrong body", async () => {
    const sig = await sign(secret, body);
    expect(await verifyGitHubSignature(secret, "different body", sig)).toBe(false);
  });

  it("rejects missing sha256= prefix", async () => {
    expect(await verifyGitHubSignature(secret, body, "not-a-sig")).toBe(false);
  });

  it("rejects empty signature header", async () => {
    expect(await verifyGitHubSignature(secret, body, "")).toBe(false);
  });
});
