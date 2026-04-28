/**
 * Convert a Prisma `Item` row into the canonical `Item` shape used by
 * proposals and the agent. The Prisma row is the cache; the canonical
 * type is the API surface.
 */

import { type Item as CanonicalItem, isItemKind, isItemState } from "@/core/types";
import type { Item as PrismaItem } from "@/db/generated/client";
import { asPlainObject } from "@/lib/json";

/**
 * Prisma stores `kind` and `state` as strings (per the schema-as-string
 * convention). Validate at the boundary so a stray row from a manual edit
 * or a migration drift fails loudly here instead of silently flowing into
 * a proposal preview as a typo'd enum.
 */
export function snapshotFromRow(row: PrismaItem): CanonicalItem {
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
    descriptionMd: row.descriptionMd,
    state: row.state,
    assignee: row.assignee,
    author: row.author,
    parentId: row.parentId,
    tags: row.tags,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    url: row.url,
    repositoryUrl: row.repositoryUrl,
    attachments: [],
    providerRaw: asPlainObject(row.providerRaw),
    providerKey: "",
  };
}
