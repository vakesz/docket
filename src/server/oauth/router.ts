import "server-only";
import { z } from "zod";
import { listProviderSpecs } from "@/server/provider-registry";
import { encryptSecret } from "@/server/secrets/encryption";
import { mutationProcedure, protectedProcedure, router } from "@/server/trpc";

/**
 * OAuth provider kinds the picker accepts — derived from the registry.
 * A spec with `oauth !== null` declares OAuth support; `auth-build.ts`
 * dispatches to the matching NextAuth adapter. Adding a new OAuth-capable
 * provider is one new entry in `provider-registry.ts` plus a case in
 * `auth-build.ts`; this enum updates automatically.
 *
 * The DB column is plain `String` so a deployment can carry a forward-
 * compatible row from a future migration without a schema bump; this Zod
 * enum simply gates what the admin UI will offer today.
 */
const OAUTH_KIND_VALUES = listProviderSpecs()
  .filter((spec) => spec.oauth !== null)
  .map((spec) => spec.typeId);
if (OAUTH_KIND_VALUES.length === 0) {
  throw new Error(
    "oauth/router: no provider in PROVIDER_SPECS declares an `oauth` block; the OAuth picker would be empty.",
  );
}
const OAUTH_KIND = z.enum(OAUTH_KIND_VALUES as [string, ...string[]]);

const CreateOauthProviderInput = z.object({
  kind: OAUTH_KIND,
  label: z.string().min(1).max(80),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().min(1),
  /** Comma-separated provider-specific scope list. Empty = adapter default. */
  scopes: z.string().max(500).default(""),
  /**
   * Optional override for the OAuth API base URL. Used for self-hosted
   * GitHub Enterprise and (today) the Entra tenant id for Azure DevOps —
   * see `auth-build.ts` for the per-kind interpretation.
   */
  baseUrl: z.string().max(500).default(""),
});

/**
 * Edit shape — same as create minus `kind` (immutable, since it pins the
 * callback URL + the `Account.provider` foreign key on existing sessions),
 * and with `clientSecret` optional. Empty/missing secret means "keep the
 * existing ciphertext" so admins can edit a label without re-pasting it.
 */
const UpdateOauthProviderInput = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(80),
  clientId: z.string().min(1).max(200),
  clientSecret: z.string().optional(),
  scopes: z.string().max(500).default(""),
  baseUrl: z.string().max(500).default(""),
});

export const oauthProvidersRouter = router({
  /** List all configured OAuth providers. Visible to any authenticated user. */
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.oauthProviderConfig.findMany({
      orderBy: [{ enabled: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        kind: true,
        label: true,
        clientId: true,
        scopes: true,
        baseUrl: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
        // clientSecret deliberately omitted from list responses.
      },
    });
  }),

  create: mutationProcedure.input(CreateOauthProviderInput).mutation(async ({ ctx, input }) => {
    const created = await ctx.db.oauthProviderConfig.create({
      data: { ...input, clientSecret: encryptSecret(input.clientSecret) },
    });
    return { id: created.id, kind: created.kind, label: created.label };
  }),

  update: mutationProcedure.input(UpdateOauthProviderInput).mutation(async ({ ctx, input }) => {
    const { id, clientSecret, ...rest } = input;
    const data: Record<string, unknown> = { ...rest };
    const trimmedSecret = clientSecret?.trim();
    if (trimmedSecret) {
      data["clientSecret"] = encryptSecret(trimmedSecret);
    }
    await ctx.db.oauthProviderConfig.update({ where: { id }, data });
    return { ok: true } as const;
  }),

  /** Toggle the row's enabled flag — hides the sign-in button without losing config. */
  setEnabled: mutationProcedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.oauthProviderConfig.update({
        where: { id: input.id },
        data: { enabled: input.enabled },
      });
      return { ok: true } as const;
    }),

  delete: mutationProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.oauthProviderConfig.delete({ where: { id: input.id } });
      return { ok: true } as const;
    }),
});
