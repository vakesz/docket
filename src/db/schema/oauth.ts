import { boolean, index, pgTable, text } from "drizzle-orm/pg-core";
import { emptyJsonbObject, pkUuid, timestamps } from "@/db/columns";

// Per-deployment OAuth provider config. Bootstrap happens via env-driven seed
// (`bin/seed-dev.ts`); afterwards the operator manages rows from `/settings`.
// Multi-row from day one; `kind` accepts future vendors without a migration.

export type OauthProviderConfigMetadata = {
  /** Entra tenant id for `azure_devops` (`common` / `organizations` / GUID). */
  tenant?: string;
} & Record<string, unknown>;

export const oauthProviderConfigs = pgTable(
  "oauth_provider_configs",
  {
    id: pkUuid(),
    // 'github' | 'azure_devops' | future kinds. NextAuth's dynamic provider
    // config function dispatches on this string.
    kind: text().notNull(),
    label: text().notNull(),
    clientId: text().notNull(),
    // AES-256-GCM ciphertext (`enc:v1:<iv>:<ct+tag>`).
    clientSecret: text().notNull(),
    scopes: text().notNull().default(""),
    // Per-provider auxiliary configuration as a free-form JSON object.
    // Today only `azure_devops` reads `metadata.tenant`. Future providers
    // needing per-row config that doesn't fit `scopes` get a key here without
    // a migration. The shape is interpreted by `auth-build.ts` per kind.
    metadata: emptyJsonbObject<OauthProviderConfigMetadata>(),
    enabled: boolean().notNull().default(true),
    ...timestamps(),
  },
  (t) => [index("oauth_provider_configs_kind_idx").on(t.kind)],
);
