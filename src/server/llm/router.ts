import "server-only";
import { z } from "zod";
import { mutationProcedure, protectedProcedure, router } from "@/server/trpc";

/**
 * LLM kinds the picker exposes. The DB column accepts any string so future
 * vendors land without a migration; this list is the *current* known set.
 * At launch only `openai` ships an adapter (Phase 6).
 */
const LLM_KIND = z.enum(["openai", "anthropic", "gemini", "bedrock", "mistral", "ollama"]);

const CreateLlmProviderInput = z.object({
  kind: LLM_KIND,
  label: z.string().min(1).max(80),
  apiKey: z.string().min(1),
  model: z.string().max(120).default(""),
  baseUrl: z.string().max(500).default(""),
  isDefault: z.boolean().default(false),
});

export const llmProvidersRouter = router({
  /** List all configured LLM providers. Visible to any authenticated user. */
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.llmProvider.findMany({
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        kind: true,
        label: true,
        model: true,
        baseUrl: true,
        isDefault: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
        // apiKey deliberately omitted from list responses.
      },
    });
  }),

  /**
   * Create a row. If `isDefault` is true, clear the flag on every other row
   * first — at most one global default.
   */
  create: mutationProcedure.input(CreateLlmProviderInput).mutation(async ({ ctx, input }) => {
    if (input.isDefault) {
      await ctx.db.llmProvider.updateMany({
        where: { isDefault: true },
        data: { isDefault: false },
      });
    }
    const created = await ctx.db.llmProvider.create({ data: input });
    return { id: created.id, kind: created.kind, label: created.label };
  }),

  /** Mark this provider as the global default; clears the flag on the others. */
  setDefault: mutationProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.$transaction([
        ctx.db.llmProvider.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        }),
        ctx.db.llmProvider.update({
          where: { id: input.id },
          data: { isDefault: true },
        }),
      ]);
      return { ok: true } as const;
    }),

  delete: mutationProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.llmProvider.delete({ where: { id: input.id } });
      return { ok: true } as const;
    }),
});
