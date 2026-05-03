import "server-only";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { LLM_KINDS } from "@/agent/llm/types";
import { llmProviders, projects } from "@/db/schema";
import { LLM_ROLES } from "@/server/llm/lookup";
import { PriceCentsPerMtokSchema, priceFromString, priceToString } from "@/server/llm/pricing";
import { logger } from "@/server/logger";
import { encryptSecret } from "@/server/secrets/encryption";
import {
  assertFound,
  mutationProcedure,
  projectScopedMutationProcedure,
  protectedProcedure,
  router,
} from "@/server/trpc";

const LLM_KIND = z.enum(LLM_KINDS);

const LLM_ROLE = z.enum(LLM_ROLES);

const CreateLlmProviderInput = z.object({
  kind: LLM_KIND,
  role: LLM_ROLE.default("chat"),
  label: z.string().min(1).max(80),
  apiKey: z.string().min(1),
  model: z.string().max(120).default(""),
  baseUrl: z.string().max(500).default(""),
  inputPriceCentsPerMtok: PriceCentsPerMtokSchema.default(null),
  outputPriceCentsPerMtok: PriceCentsPerMtokSchema.default(null),
  isDefault: z.boolean().default(false),
});

const UpdateLlmProviderInput = z.object({
  id: z.string().min(1),
  kind: LLM_KIND,
  label: z.string().min(1).max(80),
  apiKey: z.string().max(500).default(""),
  model: z.string().max(120).default(""),
  baseUrl: z.string().max(500).default(""),
  inputPriceCentsPerMtok: PriceCentsPerMtokSchema.default(null),
  outputPriceCentsPerMtok: PriceCentsPerMtokSchema.default(null),
});

export const llmProvidersRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.query.llmProviders.findMany({
      orderBy: [asc(llmProviders.role), desc(llmProviders.isDefault), desc(llmProviders.createdAt)],
      columns: {
        id: true,
        kind: true,
        role: true,
        label: true,
        model: true,
        baseUrl: true,
        inputPriceCentsPerMtok: true,
        outputPriceCentsPerMtok: true,
        isDefault: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return rows.map((row) => ({
      ...row,
      inputPriceCentsPerMtok: priceFromString(row.inputPriceCentsPerMtok),
      outputPriceCentsPerMtok: priceFromString(row.outputPriceCentsPerMtok),
    }));
  }),

  create: mutationProcedure.input(CreateLlmProviderInput).mutation(async ({ ctx, input }) => {
    const created = await ctx.db.transaction(async (tx) => {
      if (input.isDefault) {
        await tx
          .update(llmProviders)
          .set({ isDefault: false })
          .where(and(eq(llmProviders.role, input.role), eq(llmProviders.isDefault, true)));
      }
      const [row] = await tx
        .insert(llmProviders)
        .values({
          kind: input.kind,
          role: input.role,
          label: input.label,
          apiKey: encryptSecret(input.apiKey),
          model: input.model,
          baseUrl: input.baseUrl,
          inputPriceCentsPerMtok: priceToString(input.inputPriceCentsPerMtok),
          outputPriceCentsPerMtok: priceToString(input.outputPriceCentsPerMtok),
          isDefault: input.isDefault,
        })
        .returning();
      if (!row) throw new Error("llm provider create returned no row");
      return row;
    });
    logger.info(
      {
        actorUserId: ctx.userId,
        llmProviderId: created.id,
        kind: created.kind,
        role: created.role,
        isDefault: input.isDefault,
      },
      "llm: provider created",
    );
    return { id: created.id, kind: created.kind, role: created.role, label: created.label };
  }),

  update: mutationProcedure.input(UpdateLlmProviderInput).mutation(async ({ ctx, input }) => {
    const { id, apiKey, ...rest } = input;
    await ctx.db
      .update(llmProviders)
      .set({
        kind: rest.kind,
        label: rest.label,
        model: rest.model,
        baseUrl: rest.baseUrl,
        inputPriceCentsPerMtok: priceToString(rest.inputPriceCentsPerMtok),
        outputPriceCentsPerMtok: priceToString(rest.outputPriceCentsPerMtok),
        ...(apiKey ? { apiKey: encryptSecret(apiKey) } : {}),
      })
      .where(eq(llmProviders.id, id));
    return { ok: true } as const;
  }),

  setDefault: mutationProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const role = await ctx.db.transaction(async (tx) => {
        const row = assertFound(
          await tx.query.llmProviders.findFirst({
            where: eq(llmProviders.id, input.id),
            columns: { id: true, role: true },
          }),
          "Provider row not found.",
        );
        await tx
          .update(llmProviders)
          .set({ isDefault: false })
          .where(and(eq(llmProviders.role, row.role), eq(llmProviders.isDefault, true)));
        await tx.update(llmProviders).set({ isDefault: true }).where(eq(llmProviders.id, input.id));
        return row.role;
      });
      logger.info(
        { actorUserId: ctx.userId, llmProviderId: input.id, role },
        "llm: deployment default changed",
      );
      return { ok: true } as const;
    }),

  setEnabled: mutationProcedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(llmProviders)
        .set({ enabled: input.enabled })
        .where(eq(llmProviders.id, input.id));
      logger.info(
        { actorUserId: ctx.userId, llmProviderId: input.id, enabled: input.enabled },
        "llm: provider enabled flag changed",
      );
      return { ok: true } as const;
    }),

  setProjectDefault: projectScopedMutationProcedure
    .input(
      z.object({
        projectSlug: z.string().min(1),
        role: LLM_ROLE,
        id: z.string().min(1).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.id) {
        const row = assertFound(
          await ctx.db.query.llmProviders.findFirst({
            where: eq(llmProviders.id, input.id),
            columns: { id: true, role: true, enabled: true },
          }),
          "Provider row not found.",
        );
        if (row.role !== input.role) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Provider is a '${row.role}' row; cannot use it as the '${input.role}' default.`,
          });
        }
        if (!row.enabled) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "Provider is disabled; enable it before pinning it as the project default.",
          });
        }
      }
      const data =
        input.role === "chat"
          ? { defaultLlmProviderId: input.id }
          : { defaultGuardrailProviderId: input.id };
      await ctx.db.update(projects).set(data).where(eq(projects.id, ctx.projectId));
      return { ok: true } as const;
    }),

  delete: mutationProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.delete(llmProviders).where(eq(llmProviders.id, input.id));
      logger.info({ actorUserId: ctx.userId, llmProviderId: input.id }, "llm: provider deleted");
      return { ok: true } as const;
    }),
});
