/**
 * Convert a Prisma `Item` row into the canonical `Item` shape used by
 * proposals and the agent. The Prisma row is the cache; the canonical
 * type is the API surface.
 */

import type { Item as CanonicalItem, ItemKind, ItemState } from "@/core/types";
import type { Item as PrismaItem } from "@/db/generated/client";

export function snapshotFromRow(row: PrismaItem): CanonicalItem {
  return {
    id: row.providerItemId,
    kind: row.kind as ItemKind,
    title: row.title,
    descriptionMd: row.descriptionMd,
    state: row.state as ItemState,
    assignee: row.assignee,
    author: row.author,
    parentId: row.parentId,
    tags: row.tags,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    url: row.url,
    repositoryUrl: row.repositoryUrl,
    attachments: [],
    providerRaw:
      row.providerRaw && typeof row.providerRaw === "object"
        ? (row.providerRaw as Record<string, unknown>)
        : {},
    providerKey: "",
  };
}
