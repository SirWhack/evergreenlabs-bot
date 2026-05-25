import { describe, it, expect } from "vitest";
import { extractUniqueCommits } from "./commits";
import type { PendingEvent } from "./state";

function makePushEvent(commits: Array<{ id: string }>, deliveryId = "d1"): PendingEvent {
  return {
    delivery_id: deliveryId,
    event: "push",
    payload: { commits },
    received_at: 1000,
  };
}

describe("extractUniqueCommits", () => {
  it("extracts commits from a single push event", () => {
    const events = [makePushEvent([{ id: "abc123" }, { id: "def456" }])];
    const result = extractUniqueCommits(events, "SirWhack/foo", "foo");
    expect(result).toEqual([
      { sha: "abc123", repoFullName: "SirWhack/foo", repoShortName: "foo" },
      { sha: "def456", repoFullName: "SirWhack/foo", repoShortName: "foo" },
    ]);
  });

  it("deduplicates commits across multiple push events", () => {
    const events = [
      makePushEvent([{ id: "abc" }, { id: "def" }], "d1"),
      makePushEvent([{ id: "def" }, { id: "ghi" }], "d2"),
    ];
    const result = extractUniqueCommits(events, "SirWhack/foo", "foo");
    expect(result.map((c) => c.sha)).toEqual(["abc", "def", "ghi"]);
  });

  it("preserves push order (first seen wins)", () => {
    const events = [
      makePushEvent([{ id: "first" }], "d1"),
      makePushEvent([{ id: "second" }], "d2"),
    ];
    const result = extractUniqueCommits(events, "X/Y", "Y");
    expect(result[0].sha).toBe("first");
    expect(result[1].sha).toBe("second");
  });

  it("ignores non-push events", () => {
    const events: PendingEvent[] = [
      { delivery_id: "d1", event: "repository", payload: { action: "created" }, received_at: 1000 },
      makePushEvent([{ id: "abc" }], "d2"),
    ];
    const result = extractUniqueCommits(events, "X/Y", "Y");
    expect(result).toHaveLength(1);
    expect(result[0].sha).toBe("abc");
  });

  it("returns empty array when no push events", () => {
    const events: PendingEvent[] = [
      { delivery_id: "d1", event: "create", payload: {}, received_at: 1000 },
    ];
    expect(extractUniqueCommits(events, "X/Y", "Y")).toEqual([]);
  });

  it("returns empty array for push with no commits", () => {
    const events = [makePushEvent([])];
    expect(extractUniqueCommits(events, "X/Y", "Y")).toEqual([]);
  });

  it("skips commits with missing id", () => {
    const events = [makePushEvent([{ id: "" }, { id: "valid" }])];
    const result = extractUniqueCommits(events, "X/Y", "Y");
    expect(result).toHaveLength(1);
    expect(result[0].sha).toBe("valid");
  });
});
