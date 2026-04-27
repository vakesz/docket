import { describe, expect, it } from "vitest";
import type { Item, ItemKind, ItemState } from "@/core/types";
import { ITEM_STATES } from "@/core/types";
import {
  applyViewFilter,
  EMPTY_VIEW_FILTER,
  filterByAssignees,
  filterByAxes,
  filterByStateBucket,
  STATE_BUCKET_MEMBERS,
  type ViewFilter,
} from "@/core/view-filter";

function fakeItem(overrides: Partial<Item> & { id: string }): Item {
  return {
    id: overrides.id,
    kind: (overrides.kind ?? "task") as ItemKind,
    title: overrides.title ?? "t",
    descriptionMd: overrides.descriptionMd ?? "",
    state: (overrides.state ?? "active") as ItemState,
    assignee: overrides.assignee ?? null,
    parentId: overrides.parentId ?? null,
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? null,
    updatedAt: overrides.updatedAt ?? null,
    url: overrides.url ?? null,
    author: overrides.author ?? null,
    repositoryUrl: overrides.repositoryUrl ?? null,
    attachments: overrides.attachments ?? [],
    providerRaw: overrides.providerRaw ?? {},
    providerKey: overrides.providerKey ?? "fake:test",
  };
}

describe("STATE_BUCKET_MEMBERS", () => {
  it("partitions every canonical ItemState across open + closed (no leftovers, no overlap)", () => {
    const open = new Set<string>(STATE_BUCKET_MEMBERS.open);
    const closed = new Set<string>(STATE_BUCKET_MEMBERS.closed);
    for (const s of ITEM_STATES) {
      const inOpen = open.has(s);
      const inClosed = closed.has(s);
      expect(inOpen || inClosed, `state '${s}' missing from both buckets`).toBe(true);
      expect(inOpen && inClosed, `state '${s}' in both buckets`).toBe(false);
    }
  });
});

describe("filterByStateBucket", () => {
  const items = [
    fakeItem({ id: "n", state: "new" }),
    fakeItem({ id: "a", state: "active" }),
    fakeItem({ id: "b", state: "blocked" }),
    fakeItem({ id: "i", state: "needs_info" }),
    fakeItem({ id: "r", state: "resolved" }),
    fakeItem({ id: "c", state: "closed" }),
  ];

  it("open keeps new/active/blocked/needs_info", () => {
    expect(filterByStateBucket(items, "open").map((x) => x.id)).toEqual(["n", "a", "b", "i"]);
  });

  it("closed keeps resolved/closed", () => {
    expect(filterByStateBucket(items, "closed").map((x) => x.id)).toEqual(["r", "c"]);
  });

  it("all is identity (returns a fresh array, not the same reference)", () => {
    const out = filterByStateBucket(items, "all");
    expect(out.map((x) => x.id)).toEqual(items.map((x) => x.id));
    expect(out).not.toBe(items);
  });
});

describe("filterByAssignees", () => {
  const items = [
    fakeItem({ id: "u", assignee: null }),
    fakeItem({ id: "a", assignee: "alice" }),
    fakeItem({ id: "b", assignee: "bob" }),
  ];

  it("empty list is identity", () => {
    expect(filterByAssignees(items, []).map((x) => x.id)).toEqual(["u", "a", "b"]);
  });

  it("matches by assignee name", () => {
    expect(filterByAssignees(items, ["alice"]).map((x) => x.id)).toEqual(["a"]);
  });

  it("empty string in the list matches unassigned (null assignee)", () => {
    expect(filterByAssignees(items, [""]).map((x) => x.id)).toEqual(["u"]);
  });

  it("mixes named + unassigned", () => {
    expect(filterByAssignees(items, ["", "bob"]).map((x) => x.id)).toEqual(["u", "b"]);
  });
});

describe("filterByAxes", () => {
  const items = [
    fakeItem({ id: "x", providerRaw: { area: "A\\B" } }),
    fakeItem({ id: "y", providerRaw: { area: "A\\C" } }),
    fakeItem({ id: "z", providerRaw: { area: "Q" } }),
  ];
  const matcher = (item: Item, axisKey: string, expected: string) => {
    const v = (item.providerRaw as Record<string, unknown>)[axisKey];
    return typeof v === "string" && v.startsWith(expected);
  };

  it("null matcher is identity (no axes to match)", () => {
    expect(filterByAxes(items, { area: "A" }, null).map((x) => x.id)).toEqual(["x", "y", "z"]);
  });

  it("empty axes is identity", () => {
    expect(filterByAxes(items, {}, matcher).map((x) => x.id)).toEqual(["x", "y", "z"]);
  });

  it("empty axis values are skipped (treated as 'no constraint')", () => {
    expect(filterByAxes(items, { area: "" }, matcher).map((x) => x.id)).toEqual(["x", "y", "z"]);
  });

  it("matches via the spec's matcher (UNDER semantics here)", () => {
    expect(filterByAxes(items, { area: "A" }, matcher).map((x) => x.id)).toEqual(["x", "y"]);
  });

  it("AND across multiple axes", () => {
    const items2 = [
      fakeItem({ id: "p", providerRaw: { area: "A", iter: "Sprint 1" } }),
      fakeItem({ id: "q", providerRaw: { area: "A", iter: "Sprint 2" } }),
    ];
    expect(filterByAxes(items2, { area: "A", iter: "Sprint 1" }, matcher).map((x) => x.id)).toEqual(
      ["p"],
    );
  });
});

describe("applyViewFilter", () => {
  it("composes bucket + assignees + axes", () => {
    const items = [
      fakeItem({ id: "1", state: "active", assignee: "alice", providerRaw: { area: "A" } }),
      fakeItem({ id: "2", state: "active", assignee: "bob", providerRaw: { area: "A" } }),
      fakeItem({ id: "3", state: "closed", assignee: "alice", providerRaw: { area: "A" } }),
      fakeItem({ id: "4", state: "active", assignee: "alice", providerRaw: { area: "B" } }),
    ];
    const view: ViewFilter = {
      stateBucket: "open",
      assignees: ["alice"],
      axes: { area: "A" },
    };
    const matcher = (item: Item, axisKey: string, expected: string) =>
      (item.providerRaw as Record<string, unknown>)[axisKey] === expected;

    expect(applyViewFilter(items, view, matcher).map((x) => x.id)).toEqual(["1"]);
  });

  it("empty view filter is open-bucket-only", () => {
    const items = [
      fakeItem({ id: "open", state: "active" }),
      fakeItem({ id: "done", state: "closed" }),
    ];
    expect(applyViewFilter(items, EMPTY_VIEW_FILTER, null).map((x) => x.id)).toEqual(["open"]);
  });
});
