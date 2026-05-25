import { describe, it, expect } from "vitest";
import { passesSanity, formatFiles, projectSlugForRepo } from "./log_drafter";

describe("passesSanity", () => {
  it("passes for body >= 20 chars", () => {
    const result = passesSanity({ date: "may 24", year: "2026", body: "a".repeat(20), project: null });
    expect(result.ok).toBe(true);
  });

  it("fails for body < 20 chars", () => {
    const result = passesSanity({ date: "may 24", year: "2026", body: "short", project: null });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("too short");
  });

  it("fails for empty body", () => {
    const result = passesSanity({ date: "may 24", year: "2026", body: "", project: null });
    expect(result.ok).toBe(false);
  });

  it("trims whitespace before checking length", () => {
    const result = passesSanity({ date: "may 24", year: "2026", body: "   short   ", project: null });
    expect(result.ok).toBe(false);
  });

  it("handles undefined body gracefully", () => {
    const result = passesSanity({ date: "may 24", year: "2026", body: undefined as any, project: null });
    expect(result.ok).toBe(false);
  });
});

describe("formatFiles", () => {
  it("returns '(none)' for empty array", () => {
    expect(formatFiles([])).toBe("(none)");
  });

  it("joins <= 6 files with commas", () => {
    expect(formatFiles(["a.ts", "b.ts"])).toBe("a.ts, b.ts");
  });

  it("shows exactly 6 files without truncation", () => {
    const files = ["a", "b", "c", "d", "e", "f"];
    expect(formatFiles(files)).toBe("a, b, c, d, e, f");
  });

  it("truncates beyond 6 files with count", () => {
    const files = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(formatFiles(files)).toBe("a, b, c, d, e, f, … (+2 more)");
  });
});

describe("projectSlugForRepo", () => {
  const projects = [{ slug: "evergreenlabs-bot" }, { slug: "dmscreen" }, { slug: "Foo-Bar" }];

  it("finds exact match", () => {
    expect(projectSlugForRepo("dmscreen", projects)).toBe("dmscreen");
  });

  it("matches case-insensitively", () => {
    expect(projectSlugForRepo("DMScreen", projects)).toBe("dmscreen");
  });

  it("returns null for unknown repo", () => {
    expect(projectSlugForRepo("unknown-repo", projects)).toBeNull();
  });

  it("returns null for empty projects", () => {
    expect(projectSlugForRepo("anything", [])).toBeNull();
  });
});
