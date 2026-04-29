/**
 * Analytics API.
 *
 * Read-only daily aggregates for the analytics charts. Both surfaces
 * accept a `days` window (1–365) so the panel can offer 7d / 30d / 90d
 * presets without re-querying the catalog.
 *
 * Project-scoped surface uses `projectScopedProcedure` — viewers can
 * read a project's spend since they can already see the conversations
 * themselves. The deployment-wide surface uses `protectedProcedure`
 * (any signed-in user); the data is just sums of token + cost columns,
 * not message content, and the deployment hub is already gated by the
 * sidebar grouping.
 */

import "server-only";
import { z } from "zod";
import { aggregateGlobalDaily, aggregateProjectDaily } from "@/server/analytics/aggregate";
import {
  projectScopedProcedure,
  projectSlugSchema,
  protectedProcedure,
  router,
} from "@/server/trpc";

const DaysInput = z.object({ days: z.number().int().min(1).max(365).default(14) });

export const analyticsRouter = router({
  projectDaily: projectScopedProcedure
    .input(DaysInput.merge(projectSlugSchema))
    .query(async ({ ctx, input }) => {
      return aggregateProjectDaily(ctx.db, ctx.projectId, input.days);
    }),

  globalDaily: protectedProcedure.input(DaysInput).query(async ({ ctx, input }) => {
    return aggregateGlobalDaily(ctx.db, input.days);
  }),
});
