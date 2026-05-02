import { customType, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { pkUuid } from "@/db/columns";

// `bytea` column type — Drizzle's bundled `bytea` wraps to/from `Buffer`,
// but we want `Uint8Array` at the boundary so we don't drag the Node
// `Buffer` type into core. postgres-js returns `bytea` as `Uint8Array` /
// `Buffer` (which is also `Uint8Array`) by default; this customType narrows
// the inferred type without a runtime mapper.
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
});

// Cached binary profile pictures for both signed-in users and assignees.
// One row per (providerKind, identifier). `bytes = null` is the
// "we checked, the provider has nothing" marker so we don't refetch every
// render.

export const avatars = pgTable(
  "avatars",
  {
    id: pkUuid(),
    providerKind: text().notNull(),
    // Provider-native person identifier — GitHub `login`, AzDO `uniqueName`.
    identifier: text().notNull(),
    bytes: bytea(),
    contentType: text(),
    // Strong validator from the source response, used to short-circuit
    // refresh fetches with a conditional GET.
    etag: text(),
    fetchedAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
    // Stamped on transient failures so the lazy path can back off rather
    // than hammering on every render. Cleared on the next successful fetch.
    failedAt: timestamp({ withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("avatars_provider_identifier_idx").on(t.providerKind, t.identifier),
    index("avatars_fetched_at_idx").on(t.fetchedAt),
  ],
);
