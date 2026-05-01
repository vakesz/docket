/**
 * Shared project-membership check.
 *
 * tRPC procedures use `projectScopedProcedure` (which mounts
 * `enforceProjectMembership`) to gate access. Surfaces that can't compose
 * tRPC middleware — currently the SSE chat-stream route — call this
 * directly so the access shape stays in one place.
 */

import "server-only";
import type { ProjectId, UserId } from "@/core/types";
import type { Project } from "@/db/generated/client";
import type { db as Db } from "@/server/db";

type Database = typeof Db;

/**
 * Project row with the ids stamped as branded types. The brand attaches
 * here so downstream code (tRPC ctx, the proposal executor) keeps its
 * argument shapes type-safe without re-stamping at every call site.
 */
export type AuthorizedProject = Omit<Project, "id" | "ownerUserId"> & {
  id: ProjectId;
  ownerUserId: UserId;
};

/**
 * Returns the project row when the user owns it or has a membership row
 * for it, otherwise `null`. Mirrors the `OR` clause inside
 * `enforceProjectMembership` in `src/server/trpc.ts` so both surfaces
 * share the same access semantics.
 *
 * Lookup is by `slug` (the URL-facing identifier) rather than the surrogate
 * CUID — every caller sources its identifier from the route params or wire
 * input.
 */
export async function projectForUser(
  db: Database,
  projectSlug: string,
  userId: UserId,
): Promise<AuthorizedProject | null> {
  const row = await db.project.findFirst({
    where: {
      slug: projectSlug,
      archivedAt: null,
      OR: [{ ownerUserId: userId }, { memberships: { some: { userId } } }],
    },
  });
  if (!row) return null;
  return row as AuthorizedProject;
}
