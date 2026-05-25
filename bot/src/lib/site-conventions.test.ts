import { describe, it, expect } from "vitest";
import { shortDate, metaString, normalizeTags, MONTHS, SKIP_NAMES } from "./site-conventions";

describe("shortDate", () => {
  it("formats ISO date as 'mon dd' + year", () => {
    const result = shortDate("2026-05-24T12:00:00Z");
    expect(result).toEqual({ date: "may 24", year: "2026" });
  });

  it("zero-pads single-digit days", () => {
    const result = shortDate("2026-01-03T00:00:00Z");
    expect(result).toEqual({ date: "jan 03", year: "2026" });
  });

  it("handles December correctly", () => {
    const result = shortDate("2025-12-31T23:59:59Z");
    expect(result).toEqual({ date: "dec 31", year: "2025" });
  });
});

describe("metaString", () => {
  it("formats as 'updated mon year'", () => {
    expect(metaString("2026-05-20T12:34:56Z")).toBe("updated may 2026");
  });

  it("handles January", () => {
    expect(metaString("2026-01-01T00:00:00Z")).toBe("updated jan 2026");
  });
});

describe("normalizeTags", () => {
  it("uppercases and limits to 4 topics", () => {
    const topics = ["react", "typescript", "next-js", "tailwind", "extra"];
    expect(normalizeTags(topics, null)).toEqual(["REACT", "TYPESCRIPT", "NEXT JS", "TAILWIND"]);
  });

  it("falls back to language when no topics", () => {
    expect(normalizeTags([], "Python")).toEqual(["PYTHON"]);
  });

  it("returns empty when no topics and no language", () => {
    expect(normalizeTags([], null)).toEqual([]);
  });

  it("replaces dashes with spaces", () => {
    expect(normalizeTags(["machine-learning"], null)).toEqual(["MACHINE LEARNING"]);
  });
});

describe("MONTHS", () => {
  it("has 12 entries", () => {
    expect(MONTHS).toHaveLength(12);
  });

  it("starts with jan and ends with dec", () => {
    expect(MONTHS[0]).toBe("jan");
    expect(MONTHS[11]).toBe("dec");
  });
});

describe("SKIP_NAMES", () => {
  it("contains evergreenlabs", () => {
    expect(SKIP_NAMES.has("evergreenlabs")).toBe(true);
  });

  it("does not contain random names", () => {
    expect(SKIP_NAMES.has("some-other-repo")).toBe(false);
  });
});
