import type { DTO } from "~/api/client";

export interface MemoryDraft {
  title: string;
  tags: string; // comma-separated; split on submit (matches the TUI)
  body_md: string;
}

export function blankDraft(): MemoryDraft {
  return { title: "", tags: "", body_md: "" };
}

export function draftFromEntry(entry: DTO["MemoryDTO"]): MemoryDraft {
  return {
    title: entry.title,
    tags: (entry.tags ?? []).join(", "),
    body_md: entry.body_md,
  };
}

function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function draftsEqual(a: MemoryDraft, b: MemoryDraft): boolean {
  return a.title === b.title && a.tags === b.tags && a.body_md === b.body_md;
}

export function serializeCreate(draft: MemoryDraft): DTO["MemoryCreateRequest"] {
  return {
    title: draft.title.trim(),
    body_md: draft.body_md,
    tags: parseTags(draft.tags),
  };
}

export function serializeUpdate(draft: MemoryDraft): DTO["MemoryUpdateRequest"] {
  return {
    title: draft.title.trim(),
    body_md: draft.body_md,
    tags: parseTags(draft.tags),
  };
}
