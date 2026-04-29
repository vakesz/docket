import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { LLM_KINDS } from "@/agent/llm/types";
import { encryptSecret } from "@/server/secrets/encryption";
import {
  assertFound,
  mutationProcedure,
  projectScopedMutationProcedure,
  protectedProcedure,
  router,
} from "@/server/trpc";

/**
 * LLM kinds the API accepts. Derived from `LLM_KINDS` (the kinds whose
 * adapter is actually wired) so the router can't persist a row with a kind
 * that has no dispatch case — `llm-kinds-have-adapters.test.ts` keeps the
 * other side of that contract honest. Adding a vendor: write the adapter,
 * add a `case` in `registry.ts`, append the kind to `LLM_KINDS`. No edit
 * here.
 */
const LLM_KIND = z.enum(LLM_KINDS);

/**
 * Per-million-tokens price in USD cents. Null clears the value (cost stays
 * unknown for that provider). The model is non-negative — there's no
 * legitimate "negative cents per Mtok".
 */
const PriceCentsPerMtok = z.number().min(0).max(1_000_000).nullable();

const LLM_ROLES = ["chat", "guardrail"] as const;
const LLM_ROLE = z.enum(LLM_ROLES);

const CreateLlmProviderInput = z.object({
  kind: LLM_KIND,
  /**
   * 'chat' — feeds the agent loop. 'guardrail' — feeds the prompt-injection /
   * topic-scope / output-safety classifier. Stamped at create time and
   * immutable afterwards: a chat row can never become a guardrail row and
   * vice versa, since resolution paths filter on this column.
   */
  role: LLM_ROLE.default("chat"),
  label: z.string().min(1).max(80),
  apiKey: z.string().min(1),
  model: z.string().max(120).default(""),
  baseUrl: z.string().max(500).default(""),
  inputPriceCentsPerMtok: PriceCentsPerMtok.default(null),
  outputPriceCentsPerMtok: PriceCentsPerMtok.default(null),
  /**
   * Mark this row as the deployment-wide default for its role. The router
   * clears the flag on any other row of the same role first, so at most one
   * `isDefault` row exists per role. Project-level pins still win at runtime.
   */
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
  inputPriceCentsPerMtok: PriceCentsPerMtok.default(null),
  outputPriceCentsPerMtok: PriceCentsPerMtok.default(null),
});

export const llmProvidersRouter = router({
  /** List all configured LLM providers. Visible to any authenticated user. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.llmProvider.findMany({
      orderBy: [{ role: "asc" }, { isDefault: "desc" }, { createdAt: "desc" }],
      select: {
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
        // apiKey deliberately omitted from list responses.
      },
    });
    // Money columns are `Decimal(12, 4)` in the DB; convert to `number` at
    // the tRPC boundary so UI consumers don't need to depend on the Prisma
    // Decimal class (and so superjson serialization stays straightforward).
    return rows.map((row) => ({
      ...row,
      inputPriceCentsPerMtok: row.inputPriceCentsPerMtok?.toNumber() ?? null,
      outputPriceCentsPerMtok: row.outputPriceCentsPerMtok?.toNumber() ?? null,
    }));
  }),

  /**
   * Create a row stamped with its role. If `isDefault` is true, clear the
   * flag on every other row of the SAME role first — at most one default
   * per role.
   */
  create: mutationProcedure.input(CreateLlmProviderInput).mutation(async ({ ctx, input }) => {
    if (input.isDefault) {
      await ctx.db.llmProvider.updateMany({
        where: { role: input.role, isDefault: true },
        data: { isDefault: false },
      });
    }
    const created = await ctx.db.llmProvider.create({
      data: { ...input, apiKey: encryptSecret(input.apiKey) },
    });
    return { id: created.id, kind: created.kind, role: created.role, label: created.label };
  }),

  /**
   * Edit label / kind / model / baseUrl, and rotate the apiKey when a
   * non-empty one is supplied. `role` and `isDefault` are intentionally not
   * editable here — `setDefault` / `setEnabled` manage them, and roles are
   * stamped at create time so resolvers can't be silently re-routed.
   */
  update: mutationProcedure.input(UpdateLlmProviderInput).mutation(async ({ ctx, input }) => {
    const { id, apiKey, ...rest } = input;
    await ctx.db.llmProvider.update({
      where: { id },
      data: apiKey ? { ...rest, apiKey: encryptSecret(apiKey) } : rest,
    });
    return { ok: true } as const;
  }),

  /**
   * Mark this provider as the deployment-wide default for its role. Clears
   * `isDefault` on every other row sharing the same role; chat and guardrail
   * defaults are independent.
   */
  setDefault: mutationProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      // Fold the role lookup into the same transaction as the writes so a
      // concurrent delete between findUnique and the update can't leave the
      // role with no default at all (the updateMany clears flags, then the
      // update would 404 — Postgres rolls the whole tx back).
      await ctx.db.$transaction(async (tx) => {
        const row = assertFound(
          await tx.llmProvider.findUnique({
            where: { id: input.id },
            select: { id: true, role: true },
          }),
          "Provider row not found.",
        );
        await tx.llmProvider.updateMany({
          where: { role: row.role, isDefault: true },
          data: { isDefault: false },
        });
        await tx.llmProvider.update({
          where: { id: input.id },
          data: { isDefault: true },
        });
      });
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

  /**
   * Pin a provider as the project's default for its role. A `chat` row
   * writes `Project.defaultLlmProviderId`; a `guardrail` row writes
   * `Project.defaultGuardrailProviderId`. Roles cannot cross — a guardrail
   * row can never become a chat default and vice versa.
   *
   * Pass `id: null` to clear the project's default for the supplied role
   * (the resolution chain falls back to the deployment-wide default).
   */
  setProjectDefault: projectScopedMutationProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        role: LLM_ROLE,
        /** Null clears the project default for the supplied role. */
        id: z.string().min(1).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.id) {
        const row = assertFound(
          await ctx.db.llmProvider.findUnique({
            where: { id: input.id },
            select: { id: true, role: true, enabled: true },
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
      await ctx.db.project.update({ where: { id: input.projectId }, data });
      return { ok: true } as const;
    }),

  delete: mutationProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.llmProvider.delete({ where: { id: input.id } });
      return { ok: true } as const;
    }),
});
