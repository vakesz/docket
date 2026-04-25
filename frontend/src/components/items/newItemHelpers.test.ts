import { describe, expect, test } from "bun:test";

import {
  ALL_KINDS,
  buildCreateRequest,
  parseTags,
  pickInitialKind,
  resolveSupportedKinds,
} from "./newItemHelpers";

describe("parseTags", () => {
  test("splits on comma and trims whitespace", () => {
    expect(parseTags(" triage, ux , regression")).toEqual(["triage", "ux", "regression"]);
  });

  test("drops empty entries", () => {
    expect(parseTags(", ,foo,")).toEqual(["foo"]);
  });

  test("empty input returns an empty list", () => {
    expect(parseTags("")).toEqual([]);
    expect(parseTags("   ")).toEqual([]);
  });
});

describe("resolveSupportedKinds", () => {
  test("filters unknown entries and keeps provider order", () => {
    expect(resolveSupportedKinds(["task", "not-a-kind", "bug"])).toEqual(["task", "bug"]);
  });

  test("falls back to the full canonical list when provider returns nothing", () => {
    expect(resolveSupportedKinds(undefined)).toEqual(ALL_KINDS);
    expect(resolveSupportedKinds([])).toEqual(ALL_KINDS);
  });

  test("falls back when every entry is unknown", () => {
    expect(resolveSupportedKinds(["nope"])).toEqual(ALL_KINDS);
  });
});

describe("pickInitialKind", () => {
  test("honors the preferred kind when supported", () => {
    expect(pickInitialKind(["story", "task", "bug"], "task")).toBe("task");
  });

  test("falls back to the first supported kind when preferred is missing", () => {
    expect(pickInitialKind(["story", "bug"], "task")).toBe("story");
  });
});

describe("buildCreateRequest", () => {
  test("trims title and normalizes blank optionals to null", () => {
    const body = buildCreateRequest({
      kind: "task",
      title: "  Ship it  ",
      description: "body",
      parentId: "  ",
      assignee: "",
      tagsRaw: "a, b",
    });
    expect(body).toEqual({
      kind: "task",
      title: "Ship it",
      description_md: "body",
      parent_id: null,
      assignee: null,
      tags: ["a", "b"],
    });
  });

  test("preserves description whitespace verbatim", () => {
    const body = buildCreateRequest({
      kind: "bug",
      title: "Crash",
      description: "  keep   this  ",
      parentId: "",
      assignee: "",
      tagsRaw: "",
    });
    expect(body.description_md).toBe("  keep   this  ");
    expect(body.tags).toEqual([]);
  });
});
