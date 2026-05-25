import { describe, it, expect } from "vitest";
import { shouldEnqueue } from "./filter";

const OWNER = "SirWhack";
const pushPayload = (owner: string, branch = "refs/heads/main") => ({
  repository: { owner: { login: owner }, full_name: `${owner}/repo`, default_branch: "main" },
  ref: branch,
});

describe("shouldEnqueue", () => {
  it("accepts push to default branch from expected owner", () => {
    expect(shouldEnqueue("push", pushPayload(OWNER), OWNER)).toBe(true);
  });

  it("rejects push from different owner", () => {
    expect(shouldEnqueue("push", pushPayload("someone-else"), OWNER)).toBe(false);
  });

  it("rejects push to non-default branch", () => {
    expect(shouldEnqueue("push", pushPayload(OWNER, "refs/heads/feature"), OWNER)).toBe(false);
  });

  it("accepts repository.created", () => {
    const payload = { action: "created", repository: { owner: { login: OWNER } } };
    expect(shouldEnqueue("repository", payload, OWNER)).toBe(true);
  });

  it("accepts create event", () => {
    const payload = { repository: { owner: { login: OWNER } } };
    expect(shouldEnqueue("create", payload, OWNER)).toBe(true);
  });

  it("accepts delete event", () => {
    const payload = { repository: { owner: { login: OWNER } } };
    expect(shouldEnqueue("delete", payload, OWNER)).toBe(true);
  });

  it("accepts merged+closed pull_request", () => {
    const payload = {
      action: "closed",
      pull_request: { merged: true },
      repository: { owner: { login: OWNER } },
    };
    expect(shouldEnqueue("pull_request", payload, OWNER)).toBe(true);
  });

  it("rejects opened pull_request", () => {
    const payload = {
      action: "opened",
      pull_request: { merged: false },
      repository: { owner: { login: OWNER } },
    };
    expect(shouldEnqueue("pull_request", payload, OWNER)).toBe(false);
  });

  it("rejects unknown event types", () => {
    const payload = { repository: { owner: { login: OWNER } } };
    expect(shouldEnqueue("issues", payload, OWNER)).toBe(false);
  });
});
