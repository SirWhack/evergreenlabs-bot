import { describe, it, expect } from "vitest";
import { stripFences } from "./llm";

describe("stripFences", () => {
  it("returns plain text unchanged", () => {
    expect(stripFences("hello world")).toBe("hello world");
  });

  it("strips ```html fences", () => {
    expect(stripFences("```html\n<b>hi</b>\n```")).toBe("<b>hi</b>");
  });

  it("strips bare ``` fences", () => {
    expect(stripFences("```\nsome code\n```")).toBe("some code");
  });

  it("strips ```json fences", () => {
    expect(stripFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips surrounding double quotes", () => {
    expect(stripFences('"hello world"')).toBe("hello world");
  });

  it("strips fences AND quotes together", () => {
    expect(stripFences('```html\n"some text"\n```')).toBe("some text");
  });

  it("handles whitespace around fences", () => {
    expect(stripFences("  ```html\ntext\n```  ")).toBe("text");
  });

  it("handles empty string", () => {
    expect(stripFences("")).toBe("");
  });

  it("does not strip single backticks", () => {
    expect(stripFences("`inline code`")).toBe("`inline code`");
  });

  it("handles fence with no language tag", () => {
    expect(stripFences("```\nline1\nline2\n```")).toBe("line1\nline2");
  });
});
