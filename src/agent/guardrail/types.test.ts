import { describe, expect, it } from "vitest";
import { extractUntrustedFields, stringifyToolResult } from "@/agent/guardrail/types";

describe("stringifyToolResult", () => {
  it("returns empty string for null/undefined", () => {
    expect(stringifyToolResult(null)).toBe("");
    expect(stringifyToolResult(undefined)).toBe("");
  });

  it("returns string results unchanged", () => {
    expect(stringifyToolResult("hello")).toBe("hello");
  });

  it("prefers data over error", () => {
    expect(stringifyToolResult({ ok: true, data: "the body" })).toBe("the body");
    expect(stringifyToolResult({ ok: true, data: { x: 1 } })).toBe(`{"x":1}`);
  });

  it("falls back to error when there's no data", () => {
    expect(stringifyToolResult({ ok: false, error: "boom" })).toBe("boom");
  });

  it("falls back to whole-result JSON when neither data nor error is present", () => {
    expect(stringifyToolResult({ ok: true })).toBe(`{"ok":true}`);
  });
});

describe("extractUntrustedFields", () => {
  it("returns empty string for null/undefined results", () => {
    expect(extractUntrustedFields(null, ["x"])).toBe("");
    expect(extractUntrustedFields(undefined, ["x"])).toBe("");
  });

  it("returns empty when result.data is missing", () => {
    expect(extractUntrustedFields({ ok: true }, ["x"])).toBe("");
    expect(extractUntrustedFields({ ok: true, data: null }, ["x"])).toBe("");
  });

  it("extracts a top-level string field", () => {
    const r = { ok: true, data: { title: "the title", id: "cmoj6" } };
    expect(extractUntrustedFields(r, ["title"])).toBe("the title");
  });

  it("extracts multiple paths joined with --- separator", () => {
    const r = { ok: true, data: { title: "T", body: "B" } };
    expect(extractUntrustedFields(r, ["title", "body"])).toBe("T\n---\nB");
  });

  it("ignores missing or null fields", () => {
    const r = { ok: true, data: { title: "T", body: null } };
    expect(extractUntrustedFields(r, ["title", "body", "missing"])).toBe("T");
  });

  it("returns empty string when every path is missing", () => {
    const r = { ok: true, data: { id: "x" } };
    expect(extractUntrustedFields(r, ["title", "body"])).toBe("");
  });

  it("supports nested object paths", () => {
    const r = { ok: true, data: { author: { name: "A", email: "a@x" } } };
    expect(extractUntrustedFields(r, ["author.name"])).toBe("A");
  });

  it("iterates an inner array with foo[].bar", () => {
    const r = {
      ok: true,
      data: {
        comments: [
          { author: "a", body: "first" },
          { author: "b", body: "second" },
        ],
      },
    };
    expect(extractUntrustedFields(r, ["comments[].body"])).toBe("first\n---\nsecond");
  });

  it("iterates a top-level array with []", () => {
    const r = {
      ok: true,
      data: [
        { title: "first", id: "1" },
        { title: "second", id: "2" },
      ],
    };
    expect(extractUntrustedFields(r, ["[].title"])).toBe("first\n---\nsecond");
  });

  it("iterates with []. when the inner item is itself a string", () => {
    const r = { ok: true, data: ["a", "b", "c"] };
    expect(extractUntrustedFields(r, ["[]"])).toBe("a\n---\nb\n---\nc");
  });

  it("skips non-array values silently when [] is requested", () => {
    const r = { ok: true, data: { items: "not-an-array" } };
    expect(extractUntrustedFields(r, ["items[].title"])).toBe("");
  });

  it("stringifies non-string scalar fields", () => {
    const r = { ok: true, data: { count: 42, ok: true } };
    expect(extractUntrustedFields(r, ["count", "ok"])).toBe("42\n---\ntrue");
  });

  it("stringifies object fields by JSON-encoding them", () => {
    const r = { ok: true, data: { payload: { kind: "comment_add", body: "hi" } } };
    expect(extractUntrustedFields(r, ["payload"])).toBe(`{"kind":"comment_add","body":"hi"}`);
  });

  it("drops empty strings inside iteration", () => {
    const r = {
      ok: true,
      data: {
        comments: [{ body: "" }, { body: "real text" }, { body: "" }],
      },
    };
    expect(extractUntrustedFields(r, ["comments[].body"])).toBe("real text");
  });
});
