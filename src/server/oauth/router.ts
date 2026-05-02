import "server-only";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { OauthAuxSlot } from "@/core/provider";
import type { OauthProviderConfigMetadata } from "@/db/schema";
import { oauthProviderConfigs } from "@/db/schema";
import { logger } from "@/server/logger";
import { getProviderSpec, listProviderSpecs } from "@/server/provider-registry";
import { encryptSecret } from "@/server/secrets/encryption";
import { mutationProcedure, protectedProcedure, router } from "@/server/trpc";

/**
 * OAuth provider kinds the picker accepts — derived from the registry.
 * A spec with `oauth !== null` declares OAuth support; `auth-build.ts`
 * dispatches to the matching NextAuth adapter. Adding a new OAuth-capable
 * provider is one new entry in `provider-registry.ts` plus a case in
 * `auth-build.ts`; this enum updates automatically.
 *
 * The DB column is plain `text` so a deployment can carry a forward-
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
   * Per-kind aux value carried by the form's "Base URL / tenant" field.
   * The server stores it in `metadata.tenant` for kinds that key off a
   * tenant id (`azure_devops`). The `auxFor(kind)` mapping below is the
   * single source of truth for which slot a kind uses; only
   * `metadataTenant` is wired today.
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

/**
 * Per-kind dispatch for the form's free-form "Base URL / tenant" input. The
 * single field on the form maps to one storage slot; each provider's spec
 * declares which slot via `oauth.auxSlot`. Kinds without an OAuth spec entry
 * default to `baseUrl` so legacy / forward-compatible rows still display —
 * but only `metadataTenant` is honoured today.
 */
function auxFor(kind: string): OauthAuxSlot {
  return getProviderSpec(kind)?.oauth?.auxSlot ?? "baseUrl";
}

/**
 * Read the kind-appropriate aux value from a row. Used by `list` so the
 * admin form sees the right value regardless of which slot the row uses.
 */
function readAux(row: { kind: string; metadata: OauthProviderConfigMetadata }): string {
  if (auxFor(row.kind) === "metadataTenant") {
    const tenant = row.metadata.tenant;
    return typeof tenant === "string" ? tenant : "";
  }
  return "";
}

function writeAux(
  kind: string,
  value: string,
  existingMetadata: OauthProviderConfigMetadata,
): OauthProviderConfigMetadata {
  const trimmed = value.trim();
  const next: OauthProviderConfigMetadata = { ...existingMetadata };
  if (auxFor(kind) === "metadataTenant") {
    if (trimmed) next.tenant = trimmed;
    else delete next.tenant;
  }
  return next;
}

export const oauthProvidersRouter = router({
  /**
   * List all configured OAuth providers. Visible to any authenticated user.
   * The `aux` field is the kind-appropriate value for the form's "Base URL /
   * tenant" input — `metadata.tenant` for `azure_devops`. The UI never reads
   * `metadata` directly.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.query.oauthProviderConfigs.findMany({
      orderBy: [desc(oauthProviderConfigs.enabled), desc(oauthProviderConfigs.createdAt)],
      columns: {
        id: true,
        kind: true,
        label: true,
        clientId: true,
        scopes: true,
        metadata: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
        // clientSecret deliberately omitted from list responses.
      },
    });
    return rows.map((row) => {
      const { metadata: _metadata, ...rest } = row;
      return { ...rest, aux: readAux(row) };
    });
  }),

  create: mutationProcedure.input(CreateOauthProviderInput).mutation(async ({ ctx, input }) => {
    const { baseUrl: aux, clientSecret, kind, ...rest } = input;
    const metadata = writeAux(kind, aux, {});
    const [created] = await ctx.db
      .insert(oauthProviderConfigs)
      .values({
        ...rest,
        kind,
        clientSecret: encryptSecret(clientSecret),
        metadata,
      })
      .returning();
    if (!created) throw new Error("oauth provider create returned no row");
    logger.info(
      { actorUserId: ctx.userId, oauthProviderId: created.id, kind: created.kind },
      "oauth: provider created",
    );
    return { id: created.id, kind: created.kind, label: created.label };
  }),

  update: mutationProcedure.input(UpdateOauthProviderInput).mutation(async ({ ctx, input }) => {
    const { id, clientSecret, baseUrl: aux, ...rest } = input;
    const existing = await ctx.db.query.oauthProviderConfigs.findFirst({
      where: eq(oauthProviderConfigs.id, id),
      columns: { kind: true, metadata: true },
    });
    if (!existing) {
      throw new Error("oauth provider not found");
    }
    const metadata = writeAux(existing.kind, aux, existing.metadata);
    const trimmedSecret = clientSecret?.trim();
    await ctx.db
      .update(oauthProviderConfigs)
      .set({
        ...rest,
        metadata,
        ...(trimmedSecret ? { clientSecret: encryptSecret(trimmedSecret) } : {}),
      })
      .where(eq(oauthProviderConfigs.id, id));
    return { ok: true } as const;
  }),

  /** Toggle the row's enabled flag — hides the sign-in button without losing config. */
  setEnabled: mutationProcedure
    .input(z.object({ id: z.string().min(1), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db
        .update(oauthProviderConfigs)
        .set({ enabled: input.enabled })
        .where(eq(oauthProviderConfigs.id, input.id));
      logger.info(
        { actorUserId: ctx.userId, oauthProviderId: input.id, enabled: input.enabled },
        "oauth: provider enabled flag changed",
      );
      return { ok: true } as const;
    }),

  delete: mutationProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.delete(oauthProviderConfigs).where(eq(oauthProviderConfigs.id, input.id));
      logger.info(
        { actorUserId: ctx.userId, oauthProviderId: input.id },
        "oauth: provider deleted",
      );
      return { ok: true } as const;
    }),
});
