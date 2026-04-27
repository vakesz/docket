/**
 * Shared project-membership check.
 *
 * tRPC procedures use `projectScopedProcedure` (which mounts
 * `enforceProjectMembership`) to gate access. Surfaces that can't compose
 * tRPC middleware — currently the SSE chat-stream route — call this
 * directly so the access shape stays in one place.
 */

import "server-only";
import type { Project } from "@/db/generated/client";
import type { db as Db } from "@/server/db";

type Database = typeof Db;

/**
 * Returns the project row when the user owns it or has a membership row
 * for it, otherwise `null`. Mirrors the `OR` clause inside
 * `enforceProjectMembership` in `src/server/trpc.ts` so both surfaces
 * share the same access semantics.
 */
export async function projectForUser(
  db: Database,
  projectId: string,
  userId: string,
): Promise<Project | null> {
  return db.project.findFirst({
    where: {
      id: projectId,
      archivedAt: null,
      OR: [{ ownerUserId: userId }, { memberships: { some: { userId } } }],
    },
  });
}
