/**
 * Pure helpers for the new-item form so the state/IO-free logic can be
 * unit-tested without a DOM runtime. The component in `NewItemModal.tsx`
 * is the only caller.
 */

import type { DTO } from "~/api/client";

type ItemKind = DTO["ItemKind"];
type CreateItemRequest = DTO["CreateItemRequest"];

export const ALL_KINDS: ItemKind[] = ["epic", "feature", "story", "task", "bug"];

export function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export function resolveSupportedKinds(raw: readonly string[] | undefined): ItemKind[] {
  const allowed: ItemKind[] = (raw ?? []).filter((k): k is ItemKind =>
    (ALL_KINDS as string[]).includes(k),
  );
  return allowed.length > 0 ? allowed : ALL_KINDS;
}

export function pickInitialKind(supported: ItemKind[], preferred: ItemKind): ItemKind {
  if (supported.includes(preferred)) return preferred;
  return supported[0] ?? "task";
}

export function buildCreateRequest(input: {
  kind: ItemKind;
  title: string;
  description: string;
  parentId: string;
  assignee: string;
  tagsRaw: string;
}): CreateItemRequest {
  return {
    kind: input.kind,
    title: input.title.trim(),
    description_md: input.description,
    parent_id: input.parentId.trim() || null,
    assignee: input.assignee.trim() || null,
    tags: parseTags(input.tagsRaw),
  };
}
