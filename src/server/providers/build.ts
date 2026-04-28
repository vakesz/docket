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
import { ProviderAuthError, ProviderError, type WorkItemProvider } from "@/core/provider";
import type { Project } from "@/db/generated/client";
import { asPlainObject } from "@/lib/json";
import { nextAuthProviderId } from "@/lib/next-auth-provider-id";
import type { db as Db } from "@/server/db";
import { getProviderSpec } from "@/server/provider-registry";

export async function buildProviderForUser(
  db: typeof Db,
  project: Pick<Project, "id" | "providerKind" | "providerScope" | "name">,
  userId: string,
): Promise<WorkItemProvider> {
  const spec = getProviderSpec(project.providerKind);
  if (!spec) {
    throw new ProviderError(
      `No provider spec registered for kind '${project.providerKind}' (project ${project.id}).`,
    );
  }

  const authProvider = nextAuthProviderId(project.providerKind);
  const account = await db.account.findFirst({
    where: { userId, provider: authProvider },
    select: { access_token: true },
    // Deterministic order: a user can in theory have multiple Account rows
    // for the same provider (re-link with a different OAuth identity).
    // Without orderBy, Postgres is free to pick a different one on different
    // connections — fine until two queries in the same turn disagree.
    orderBy: [{ providerAccountId: "asc" }],
  });
  if (!account?.access_token) {
    throw new ProviderAuthError(
      `User ${userId} has no '${authProvider}' OAuth token; sign in with that provider first.`,
    );
  }

  const scope = asPlainObject(project.providerScope);
  const config = { ...scope, accessToken: account.access_token };
  return spec.factory(config, project.name);
}
