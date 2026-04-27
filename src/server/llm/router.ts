import "server-only";
import { z } from "zod";
import { encryptSecret } from "@/server/secrets/encryption";
import { mutationProcedure, protectedProcedure, router } from "@/server/trpc";

/**
 * LLM kinds the picker exposes. The DB column accepts any string so future
 * vendors land without a migration; this list is the *current* known set.
 * Only `openai` has a wired adapter today.
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

const UpdateLlmProviderInput = z.object({
  id: z.string().min(1),
  kind: LLM_KIND,
  label: z.string().min(1).max(80),
  /** Empty string = keep the existing key. Any other value is encrypted and stored. */
  apiKey: z.string().max(500).default(""),
  model: z.string().max(120).default(""),
  baseUrl: z.string().max(500).default(""),
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
    const created = await ctx.db.llmProvider.create({
      data: { ...input, apiKey: encryptSecret(input.apiKey) },
    });
    return { id: created.id, kind: created.kind, label: created.label };
  }),

  /**
   * Edit label / kind / model / baseUrl, and rotate the apiKey when a
   * non-empty one is supplied. `isDefault` and `enabled` are managed by
   * `setDefault` / `setEnabled` so this stays a pure metadata edit.
   */
  update: mutationProcedure.input(UpdateLlmProviderInput).mutation(async ({ ctx, input }) => {
    const { id, apiKey, ...rest } = input;
    await ctx.db.llmProvider.update({
      where: { id },
      data: apiKey ? { ...rest, apiKey: encryptSecret(apiKey) } : rest,
    });
    return { ok: true } as const;
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

  /** Toggle the row's enabled flag — pulls the adapter out of rotation without losing config. */
  setEnabled: mutationProcedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.llmProvider.update({
        where: { id: input.id },
        data: { enabled: input.enabled },
      });
      return { ok: true } as const;
    }),

  delete: mutationProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.llmProvider.delete({ where: { id: input.id } });
      return { ok: true } as const;
    }),
});
