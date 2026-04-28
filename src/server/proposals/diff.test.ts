import { describe, expect, it } from "vitest";
import {
  type CommentAddDiff,
  type DescriptionPatchDiff,
  isEmptyDiff,
  type MemoryWriteDiff,
  type StateChangeDiff,
  type TagsChangeDiff,
} from "@/server/proposals/diff";

describe("isEmptyDiff", () => {
  it("flags whitespace-only comments as empty", () => {
    const diff: CommentAddDiff = {
      kind: "comment_add",
      itemId: "i1",
      itemTitle: "t",
      bodyMd: "   \n\t ",
    };
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("keeps real comments", () => {
    const diff: CommentAddDiff = {
      kind: "comment_add",
      itemId: "i1",
      itemTitle: "t",
      bodyMd: "looks good to me",
    };
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("flags description patches that match the current body", () => {
    const diff: DescriptionPatchDiff = {
      kind: "description_patch",
      itemId: "i1",
      itemTitle: "t",
      before: "hello world",
      after: "hello world",
    };
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("keeps real description patches", () => {
    const diff: DescriptionPatchDiff = {
      kind: "description_patch",
      itemId: "i1",
      itemTitle: "t",
      before: "hello",
      after: "hello world",
    };
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("flags tag changes with no add/remove", () => {
    const diff: TagsChangeDiff = {
      kind: "tags_change",
      itemId: "i1",
      itemTitle: "t",
      before: ["a", "b"],
      after: ["a", "b"],
      added: [],
      removed: [],
    };
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("keeps tag changes that add a label", () => {
    const diff: TagsChangeDiff = {
      kind: "tags_change",
      itemId: "i1",
      itemTitle: "t",
      before: ["a"],
      after: ["a", "b"],
      added: ["b"],
      removed: [],
    };
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("flags memory updates whose title and body are unchanged", () => {
    const diff: MemoryWriteDiff = {
      kind: "memory_write",
      memoryId: "m1",
      title: "T",
      bodyMd: "B",
      previousTitle: "T",
      previousBodyMd: "B",
    };
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it("keeps memory creates even when previous fields are blank", () => {
    const diff: MemoryWriteDiff = {
      kind: "memory_write",
      memoryId: null,
      title: "",
      bodyMd: "",
      previousTitle: "",
      previousBodyMd: "",
    };
    // memoryId === null means create — never empty.
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("never flags state_change as empty", () => {
    const diff: StateChangeDiff = {
      kind: "state_change",
      itemId: "i1",
      itemTitle: "t",
      intent: "start_work",
      before: "new",
    };
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("never flags item_create / memory_delete / attachment_upload as empty", () => {
    expect(
      isEmptyDiff({
        kind: "item_create",
        itemKind: "task",
        title: "x",
        descriptionMd: "",
        assignee: null,
        tags: [],
      }),
    ).toBe(false);
    expect(isEmptyDiff({ kind: "memory_delete", memoryId: "m1", title: "t" })).toBe(false);
    expect(
      isEmptyDiff({
        kind: "attachment_upload",
        itemId: "i1",
        itemTitle: "t",
        filename: "a.png",
        contentType: "image/png",
        size: 0,
      }),
    ).toBe(false);
  });
});
