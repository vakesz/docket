/**
 * Convert a cached `Item` row into the canonical `Item` shape used by
 * proposals and the agent. The DB row is the cache; the canonical type is
 * the API surface.
 */

import { type Item as CanonicalItem, isItemKind, isItemState } from "@/core/types";
import type { Item } from "@/db/schema/types";
import { asPlainObject } from "@/lib/json";

/**
 * The cache stores `kind` and `state` as open-extensibility text columns
 * (no CHECK constraint). Validate at the boundary so a stray row from a
 * manual edit or migration drift fails loudly here instead of silently
 * flowing into a proposal preview as a typo'd enum.
 */
export function snapshotFromRow(row: Item): CanonicalItem {
  if (!isItemKind(row.kind)) {
    throw new Error(`item-snapshot: unrecognized kind "${row.kind}" on item ${row.id}`);
  }
  if (!isItemState(row.state)) {
    throw new Error(`item-snapshot: unrecognized state "${row.state}" on item ${row.id}`);
  }
  return {
    id: row.providerItemId,
    kind: row.kind,
    title: row.title,
    description: row.description,
    state: row.state,
    assignee: row.assignees[0] ?? null,
    assignees: [...row.assignees],
    reviewers: [...row.reviewers],
    linkedItemIds: [...row.linkedItemIds],
    author: row.author,
    parentId: row.parentId,
    tags: [...row.tags],
    reactions: row.reactions ?? null,
    milestone: row.milestone,
    iteration: row.iteration,
    area: row.area,
    ciSummary: row.ciSummary ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
    url: row.url,
    repositoryUrl: row.repositoryUrl,
    attachments: [],
    providerRaw: asPlainObject(row.providerRaw),
    providerKey: "",
  };
}
