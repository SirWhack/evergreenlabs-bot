import { describe, it, expect } from "vitest";
import { issueStateForStatus, reconciledStatus } from "./issue_sync";

describe("issueStateForStatus (board → issue)", () => {
  it("Done closes as completed", () => {
    expect(issueStateForStatus("Done")).toEqual({
      state: "closed",
      stateReason: "completed",
    });
  });

  it("Won't Do closes as not_planned", () => {
    expect(issueStateForStatus("Won't Do")).toEqual({
      state: "closed",
      stateReason: "not_planned",
    });
  });

  it("open statuses keep the issue open", () => {
    expect(issueStateForStatus("Todo")).toEqual({ state: "open" });
    expect(issueStateForStatus("In Progress")).toEqual({ state: "open" });
  });

  it("is case-insensitive", () => {
    expect(issueStateForStatus("done").state).toBe("closed");
  });

  it("treats unrecognized statuses as open (fail safe)", () => {
    expect(issueStateForStatus("Backlog")).toEqual({ state: "open" });
  });
});

describe("reconciledStatus (issue → board)", () => {
  it("open issue with no board status → Todo", () => {
    expect(reconciledStatus(null, "open", null)).toBe("Todo");
  });

  it("open issue already Todo → no change", () => {
    expect(reconciledStatus("Todo", "open", null)).toBeNull();
  });

  it("open issue In Progress is left alone (no clobber)", () => {
    expect(reconciledStatus("In Progress", "open", null)).toBeNull();
  });

  it("open issue that board thinks is Done → reopened to Todo", () => {
    expect(reconciledStatus("Done", "open", null)).toBe("Todo");
  });

  it("closed-completed issue → Done", () => {
    expect(reconciledStatus("Todo", "closed", "completed")).toBe("Done");
  });

  it("closed-not_planned issue → Won't Do", () => {
    expect(reconciledStatus("In Progress", "closed", "not_planned")).toBe("Won't Do");
  });

  it("closed issue already Done → no change", () => {
    expect(reconciledStatus("Done", "closed", "completed")).toBeNull();
  });

  it("closed issue marked Done but reason not_planned → corrects to Won't Do", () => {
    expect(reconciledStatus("Done", "closed", "not_planned")).toBe("Won't Do");
  });

  it("is idempotent — re-running on a consistent state never writes", () => {
    // Mirrors the loop-safety guarantee: a board edit closes an issue, the
    // resulting webhook reconcile must produce no further change.
    const after = reconciledStatus("Done", "closed", "completed");
    expect(after).toBeNull();
  });
});
