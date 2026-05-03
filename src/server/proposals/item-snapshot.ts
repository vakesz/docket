/**
 * Convert a cached `Item` row into the canonical `Item` shape used by
 * proposals and the agent. The DB row is the cache; the canonical type is
 * the API surface.
 */

import type { Item as CanonicalItem } from "@/core/types";
import type { Item } from "@/db/schema/types";
import { asPlainObject } from "@/lib/json";

export function snapshotFromRow(row: Item): CanonicalItem {
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
