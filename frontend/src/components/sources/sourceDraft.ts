import type { DTO } from "~/api/client";

export interface SourceDraft {
  title: string;
  kind: string; // free-text — see KIND_PRESETS for the dropdown
  uri: string;
  tags: string; // comma-separated; split on submit (matches the TUI)
  body_md: string;
}

export const KIND_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "— uncategorized —" },
  { value: "requirements", label: "requirements" },
  { value: "design", label: "design" },
  { value: "architecture", label: "architecture" },
  { value: "runbook", label: "runbook" },
  { value: "reference", label: "reference" },
];

export function blankDraft(): SourceDraft {
  return { title: "", kind: "", uri: "", tags: "", body_md: "" };
}

export function draftFromEntry(entry: DTO["SourceDTO"]): SourceDraft {
  return {
    title: entry.title,
    kind: entry.kind ?? "",
    uri: entry.uri ?? "",
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

export function draftsEqual(a: SourceDraft, b: SourceDraft): boolean {
  return (
    a.title === b.title &&
    a.kind === b.kind &&
    a.uri === b.uri &&
    a.tags === b.tags &&
    a.body_md === b.body_md
  );
}

export function serializeCreate(draft: SourceDraft): DTO["SourceCreateRequest"] {
  return {
    title: draft.title.trim(),
    body_md: draft.body_md,
    kind: draft.kind.trim(),
    uri: draft.uri.trim(),
    tags: parseTags(draft.tags),
  };
}

export function serializeUpdate(draft: SourceDraft): DTO["SourceUpdateRequest"] {
  return {
    title: draft.title.trim(),
    body_md: draft.body_md,
    kind: draft.kind.trim(),
    uri: draft.uri.trim(),
    tags: parseTags(draft.tags),
  };
}
