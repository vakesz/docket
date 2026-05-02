/**
 * Build a `WorkItemProvider` for a project on behalf of a user.
 *
 * The session user's NextAuth `Account` row carries the OAuth access token
 * for `provider=<kind>` (e.g. "github"). We merge the token into the
 * project's `providerScope` and hand the combined config to the spec
 * factory. The result is a per-call provider instance — providers are
 * cheap to construct, and there's no shared mutable state to reuse.
 *
 * Throws `ProviderAuthError` when the user has no token for that provider
 * (the UI should redirect them to re-sign-in / connect that provider).
 */

import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { ProviderAuthError, ProviderError, type WorkItemProvider } from "@/core/provider";
import type { UserId } from "@/core/types";
import type { Db } from "@/db";
import { accounts } from "@/db/schema";
import type { Project } from "@/db/schema/types";
import { asPlainObject } from "@/lib/json";
import { getProviderSpec } from "@/server/provider-registry";

export async function buildProviderForUser(
  db: Db,
  project: Pick<Project, "id" | "providerKind" | "providerScope" | "name">,
  userId: UserId,
): Promise<WorkItemProvider> {
  const spec = getProviderSpec(project.providerKind);
  if (!spec) {
    throw new ProviderError(
      `No provider spec registered for kind '${project.providerKind}' (project ${project.id}).`,
    );
  }

  // Each provider's NextAuth wrapper sets `id: <providerKind>` so the
  // `Account.provider` column matches our `providerKind` value directly.
  // Deterministic order on providerAccountId keeps token selection stable
  // across connections when a user has multiple Account rows for the same
  // provider (re-link with a different OAuth identity).
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.userId, userId), eq(accounts.provider, project.providerKind)),
    columns: { access_token: true },
    orderBy: [asc(accounts.providerAccountId)],
  });
  if (!account?.access_token) {
    throw new ProviderAuthError(
      `User ${userId} has no '${project.providerKind}' OAuth token; sign in with that provider first.`,
    );
  }

  const scope = asPlainObject(project.providerScope);
  const config = { ...scope, accessToken: account.access_token };
  return spec.factory(config, project.name);
}
