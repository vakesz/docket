import "server-only";
import { z } from "zod";
import type { Prisma } from "@/db/generated/client";
import { asPlainObject } from "@/lib/json";
import { logger } from "@/server/logger";
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
   * Per-kind aux value carried by the form's "Base URL / tenant" field.
   * The server stores it in `baseUrl` for kinds that override the OAuth
   * endpoint (e.g. GitHub Enterprise) and in `metadata.tenant` for kinds
   * that key off a tenant id (`azure_devops`). The `auxFor(kind)` mapping
   * below is the single source of truth for which slot a kind uses.
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
 * single field on the form maps to one storage slot, and the slot differs by
 * kind: GitHub Enterprise repurposes the OAuth endpoint (`baseUrl`); Azure
 * DevOps uses the Entra tenant id (`metadata.tenant`).
 */
type OauthAuxSlot = "baseUrl" | "metadataTenant";
function auxFor(kind: string): OauthAuxSlot {
  return kind === "azure_devops" ? "metadataTenant" : "baseUrl";
}

/**
 * Read the kind-appropriate aux value from a row. Used by `list` so the
 * admin form sees the right value regardless of where the row stored it.
 * Falls back to `baseUrl` for `azure_devops` rows that haven't migrated
 * yet (mirrors the fallback in `auth-build.ts`).
 */
function readAux(row: { kind: string; baseUrl: string; metadata: unknown }): string {
  if (auxFor(row.kind) === "metadataTenant") {
    const meta = asPlainObject(row.metadata);
    const tenant = meta["tenant"];
    if (typeof tenant === "string" && tenant.length > 0) return tenant;
    return row.baseUrl;
  }
  return row.baseUrl;
}

function writeAux(
  kind: string,
  value: string,
  existingMetadata: unknown,
): { baseUrl: string; metadata: Prisma.InputJsonValue } {
  const trimmed = value.trim();
  const meta = asPlainObject(existingMetadata);
  if (auxFor(kind) === "metadataTenant") {
    if (trimmed) meta["tenant"] = trimmed;
    else delete meta["tenant"];
    // Clear `baseUrl` so a stale value from a pre-migration row doesn't
    // shadow the metadata read in `auth-build.ts`'s fallback path.
    return { baseUrl: "", metadata: meta as Prisma.InputJsonValue };
  }
  return { baseUrl: trimmed, metadata: meta as Prisma.InputJsonValue };
}

export const oauthProvidersRouter = router({
  /**
   * List all configured OAuth providers. Visible to any authenticated user.
   * The `aux` field is the kind-appropriate value for the form's "Base URL /
   * tenant" input — pulled from `baseUrl` for most kinds, `metadata.tenant`
   * for `azure_devops`. The UI never reads `baseUrl` or `metadata` directly.
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.oauthProviderConfig.findMany({
      orderBy: [{ enabled: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        kind: true,
        label: true,
        clientId: true,
        scopes: true,
        baseUrl: true,
        metadata: true,
        enabled: true,
        createdAt: true,
        updatedAt: true,
        // clientSecret deliberately omitted from list responses.
      },
    });
    return rows.map((row) => {
      const { baseUrl: _baseUrl, metadata: _metadata, ...rest } = row;
      return { ...rest, aux: readAux(row) };
    });
  }),

  create: mutationProcedure.input(CreateOauthProviderInput).mutation(async ({ ctx, input }) => {
    const { baseUrl: aux, clientSecret, kind, ...rest } = input;
    const { baseUrl, metadata } = writeAux(kind, aux, {});
    const created = await ctx.db.oauthProviderConfig.create({
      data: {
        ...rest,
        kind,
        clientSecret: encryptSecret(clientSecret),
        baseUrl,
        metadata,
      },
    });
    logger.info(
      { actorUserId: ctx.userId, oauthProviderId: created.id, kind: created.kind },
      "oauth: provider created",
    );
    return { id: created.id, kind: created.kind, label: created.label };
  }),

  update: mutationProcedure.input(UpdateOauthProviderInput).mutation(async ({ ctx, input }) => {
    const { id, clientSecret, baseUrl: aux, ...rest } = input;
    const existing = await ctx.db.oauthProviderConfig.findUniqueOrThrow({
      where: { id },
      select: { kind: true, metadata: true },
    });
    const { baseUrl, metadata } = writeAux(existing.kind, aux, existing.metadata);
    const data: Record<string, unknown> = { ...rest, baseUrl, metadata };
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
      logger.info(
        { actorUserId: ctx.userId, oauthProviderId: input.id, enabled: input.enabled },
        "oauth: provider enabled flag changed",
      );
      return { ok: true } as const;
    }),

  delete: mutationProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.oauthProviderConfig.delete({ where: { id: input.id } });
      logger.info(
        { actorUserId: ctx.userId, oauthProviderId: input.id },
        "oauth: provider deleted",
      );
      return { ok: true } as const;
    }),
});
