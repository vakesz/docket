/**
 * Link-discovery tools — find pull requests / commits the provider has
 * heuristically linked to an item.
 *
 * Today the only tool here is `find_related_pull_requests`, which calls
 * the provider's optional `findRelatedPRs` method. Providers that don't
 * model PRs (Azure DevOps in some configurations) throw `ProviderError`
 * from the optional method; we surface that as a soft `fail()` rather
 * than raising — the agent treats it as "no PR signal here, move on".
 */

import "server-only";
import { z } from "zod";
import { zodToJsonSchema } from "@/agent/tools/schema";
import type { ToolFactory } from "@/agent/tools/types";
import { fail, ok } from "@/agent/tools/types";
import { buildProviderForUser } from "@/server/providers/build";

export const findRelatedPullRequestsTool: ToolFactory = (ctx) => ({
  def: {
    name: "find_related_pull_requests",
    description:
      "Find pull requests the provider heuristically links to a cached item (id mention, branch name, keyword overlap). Defaults to the conversation's anchored item; pass providerItemId only to look up a different one. Use this before drilling into a specific PR with get_pull_request.",
    parameters: zodToJsonSchema(
      z.object({
        providerItemId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Cached item id, e.g. 'owner/repo#42' on GitHub. Defaults to the conversation's anchored item.",
          ),
      }),
    ),
  },
  handler: async (raw) => {
    const args = z.object({ providerItemId: z.string().min(1).optional() }).parse(raw);
    const providerItemId = args.providerItemId ?? ctx.providerItemId;
    if (!providerItemId) {
      return fail("providerItemId is required when no item is anchored on this conversation.");
    }
    const project = await ctx.db.project.findUnique({ where: { id: ctx.projectId } });
    if (!project) return fail(`project ${ctx.projectId} not found`);
    const provider = await buildProviderForUser(ctx.db, project, ctx.userId);
    if (!provider.findRelatedPRs) {
      return ok({ matches: [] as const, note: "provider does not surface PR links" });
    }
    try {
      const matches = await provider.findRelatedPRs(providerItemId);
      return ok({ matches });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export function linkTools(ctx: Parameters<ToolFactory>[0]) {
  return [findRelatedPullRequestsTool(ctx)] as const;
}
