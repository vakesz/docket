# Adding a Provider to Docket

This guide walks through everything you need to wire a new work-item backend
(Jira, Linear, anything else) into Docket without touching the surfaces that
consume it. The pattern is **strictly additive** — every router, server
component, and agent tool dispatches through the registry, so a new provider
package + two registry edits is enough.

If you find yourself editing `src/server/<feature>/router.ts`, `src/agent/`,
or `src/ui/` to land a provider, stop and re-read this — that's a leak the
arch tests under `src/__arch__/` exist to catch.

---

## 1. Provider or MCP server?

Two integration shapes, both real, easy to confuse:

| You want… | Use a |
| --- | --- |
| Native CRUD (transition, patch description, create item) on the canonical model, with proposal-first writes and a Postgres cache. | **Provider** (this guide). |
| Read-only adjunct that the agent calls as a tool — search, fetch, etc. — without participating in the cache or proposal flow. | **MCP server** (configured per project; see `src/agent/mcp/` and the `mcpServerConfig` table). |

If your data isn't a work item (incident timelines, runbooks, dashboards),
you almost always want MCP. If it *is* a work item but you only need
read-only access, MCP is still a reasonable choice. Pick a provider when
you genuinely need write support and want the items folded into the unified
backlog.

---

## 2. Package layout

Built-in providers live under `src/providers/<type-id>/`. The canonical
layout (mirrors `azure-devops/`; `github/` skips `auth.ts` because it
reuses NextAuth's built-in provider directly):

```text
src/providers/<type-id>/
├── auth.ts            # NextAuth provider builder, OAuth token wiring (omit if you reuse a built-in NextAuth provider)
├── provider.ts        # WorkItemProvider implementation
├── spec.ts            # ProviderSpec — declares fields, axes, factory
├── state-map.ts       # provider-native state ↔ canonical ItemState/TransitionIntent
└── state-map.test.ts  # round-trip + edge cases for state-map.ts
```

Third-party providers don't have to follow this layout — only the
`WorkItemProvider` interface and `ProviderSpec` shape are required. The
split exists so each file has one job; copying it is the path of least
resistance.

| File | Job |
| --- | --- |
| `provider.ts` | Class implementing `WorkItemProvider` (`src/core/provider.ts`). Canonical types in, canonical types out. Provider-native fields live in `Item.providerRaw` only. |
| `spec.ts` | Static `ProviderSpec`: type id, display name, factory, setup fields, scope axes, label template, supported kinds. |
| `auth.ts` | NextAuth provider builder. Imported by `src/server/providers/auth-build.ts` to translate an `OauthProviderConfig` row into a `Provider`. |
| `state-map.ts` | Two pure functions: `toCanonical(nativeState) -> ItemState` and `toNative(intent: TransitionIntent) -> string`. |
| `state-map.test.ts` | Round-trip + native-string coverage. Failing here is the cheapest way to catch state-map typos. |

---

## 3. Implement `WorkItemProvider`

The interface lives in `src/core/provider.ts`. Every method takes canonical
types in (`ItemKind`, `ItemState`, `TransitionIntent`, `CreateFields`) and
returns canonical types out (`Item`, `Comment`). Provider-native enums and
field names never escape — that's what `Item.providerRaw` is for.

```ts
export interface WorkItemProvider {
  healthCheck(): Promise<void>;

  // Yields fully-hydrated bundles (item + comments). Sync upserts both in a
  // single pass. Yield `comments: null` to skip comment reconciliation, `[]`
  // to assert "no comments." Reactions ride along inside the canonical
  // `Item.reactions` / `Comment.reactions` fields.
  listChangesSince(watermark: Date | null): AsyncIterable<ChangedItem>;

  getItem(id: string): Promise<Item>;
  getComments(id: string): Promise<Comment[]>;
  getLinked(id: string): Promise<Item[]>;

  transition(id: string, intent: TransitionIntent): Promise<Item>;
  patchDescription(id: string, newDescription: string): Promise<Item>;
  uploadAttachment(
    id: string, filename: string, content: Uint8Array, contentType: string,
  ): Promise<string>;
  addComment(id: string, body: string): Promise<Comment>;
  createItem(kind: ItemKind, fields: CreateFields): Promise<Item>;
  setTags(id: string, tags: readonly string[]): Promise<Item>;

  // Required — backs the @me visual filter. Return null when the provider
  // can't resolve its own identity cheaply; @me then degrades to "no filter".
  currentUserIdentity(): Promise<string | null>;

  // Optional — agent tools fall back gracefully if the provider doesn't
  // have the concept (throw `ProviderError("not supported")`).
  findRelatedPRs?(id: string): Promise<PRMatch[]>;
  getPullRequest?(prId: string): Promise<PullRequestDetail>;
  getPullRequestDiff?(prId: string): Promise<PullRequestDiff>;
  getCommit?(sha: string): Promise<CommitDetail>;
  getCIStatus?(ref: string): Promise<CIStatus>;
  searchPullRequests?(
    query: string,
    opts: { state: "open" | "closed" | "merged" | "all"; limit: number },
  ): Promise<PRMatch[]>;
  searchCode?(query: string, limit: number): Promise<CodeSearchResult>;

  // Optional — only implement when `capabilities.supportedReactions` is
  // non-empty. Validate the `reaction` against that list and throw
  // `ProviderError` on unknown kinds. Returns the post-write reaction summary
  // so the proposal executor can refresh the cache without an extra fetch.
  addReaction?(target: ReactionTarget, reaction: string): Promise<{ reactions: Reactions }>;
  removeReaction?(target: ReactionTarget, reaction: string): Promise<{ reactions: Reactions }>;
}
```

Reference impls:

- `src/providers/github/provider.ts` — Octokit-backed production reference.
- `src/providers/azure-devops/provider.ts` — Azure DevOps SDK; demonstrates
  Markdown ↔ HTML round-tripping for description fields.

**Items must carry `providerKey`** (the `Project.id`) when returned from
`listChangesSince` or `getItem`. Sync upserts use it to scope the cache to
the right project entry. The sync service does this for you when writing
through Prisma; read paths that bypass it (rare) need to stamp it.

**`Item.providerRaw`** is the right place to stash provider-native fields
your `axisMatcher` will read (see §6). Never expose them to surfaces directly.

---

## 4. State map

Canonical states live in `src/core/types.ts`:

```ts
export type ItemState =
  | "new" | "active" | "blocked" | "needs_info" | "resolved" | "closed";

export type TransitionIntent =
  | "start_work" | "pause" | "block" | "needs_info"
  | "close_done" | "close_wontfix" | "reopen";
```

`state-map.ts` exports two pure functions — one per direction:

```ts
export function toCanonical(native: string): ItemState { ... }
export function toNative(intent: TransitionIntent): string { ... }
```

For native states the provider returns that don't fit the canonical
buckets, lean toward `"active"` ("in flight") or `"new"` ("not started")
rather than inventing a new enum value. Agent tools and the UI's
state-bucket grouping rely on the existing six.

The round-trip belongs in `state-map.test.ts`: every `TransitionIntent`
must map to a native string that, when read back, canonicalizes to the
right `ItemState` for the resulting transition. Copy `github/state-map.test.ts`
as a starting point.

---

## 5. `ProviderSpec`

The spec is the static description of the provider type. Construct one and
add it to `PROVIDER_SPECS` in `src/server/provider-registry.ts`.

```ts
import type { LabelTemplate, ProviderSpec } from "@/core/provider";
import { AcmeProvider } from "@/providers/acme/provider";

const labelTemplate: LabelTemplate = (config) => {
  const tenant = typeof config.tenant === "string" ? config.tenant.trim() : "";
  return tenant || "";
};

export const acmeSpec = {
  typeId: "acme",                   // wire id; matches OauthProviderConfig.kind + Project.providerKind
  displayName: "ACME Tracker",
  factory: (config, displayName) => new AcmeProvider(config),
  requiresCli: [],                  // CLI binaries the bootstrap probes (rare; usually empty)
  setupFields: [
    {
      key: "tenant",
      label: "ACME tenant",
      kind: "url",                  // "string" | "url" | "secret"
      required: true,
      placeholder: "https://acme.example.com",
      help: "Tenant URL.",
    },
  ],
  normalizeConfig: (raw) => {       // null when no normalization is needed
    const tenant = typeof raw.tenant === "string" ? raw.tenant.trim() : "";
    if (!tenant) throw new Error("ACME: 'tenant' is required");
    return { tenant };
  },
  labelTemplate,                    // null when bare type id is enough
  grouping: "by_state_bucket",      // or "by_kind" — drives backlog grouping in the UI
  scopeAxes: [
    { key: "squad", label: "Squad", discoveryStage: "squads" },
    { key: "component", label: "Component", discoveryStage: null },  // null → free-form
  ],
  axisMatcher: acmeAxisMatcher,     // required iff scopeAxes is non-empty
  axisExtract: acmeAxisExtract,     // required iff scopeAxes is non-empty
  itemNumberCodec: {                // required — see §5.1
    parseItemNumber: (_scope, urlNumber) => (/^\d+$/.test(urlNumber) ? urlNumber : null),
    formatItemNumber: (id) => id,
  },
  capabilities: {                   // required — drives UI capability gating
    supportedReactions: [],         // empty → UI hides reactions strip
    ciStatus: false,
    pullRequestDiffs: false,
    linkedItems: false,
    creatableKinds: ["story", "task", "bug"],   // first entry is the create-form default; non-empty
  },
  availableIntents: (state) => {    // trim intents the provider can't represent from `state`
    if (state === "closed") return ["reopen"] as const;
    return ["start_work", "pause", "block", "needs_info", "close_done", "close_wontfix"] as const;
  },
  oauth: {                          // null when the provider isn't OAuth-backed
    defaultLabel: "ACME",
    defaultScopes: "read:items write:items",
    baseUrlPlaceholder: "https://acme.example.com",
    baseUrlHelpKey: "",
  },
  profileUrl: null,                 // (identity) => string | null; null when no public profile URL exists
  avatarFetcher: null,              // null keeps initials-only avatars in the UI
} satisfies ProviderSpec;
```

**`setupFields`** drive any future setup UI surface; today, the bootstrap
seed and the OAuth provider panel under `/settings` (`src/ui/settings/oauth-providers-panel.tsx`)
read them to render forms.

**`grouping`** controls how the UI groups the backlog tree. `"by_kind"`
nests epics → features → stories → tasks → bugs (Azure DevOps).
`"by_state_bucket"` collapses to Open vs Done (GitHub Issues).

**`scopeAxes`** declares the provider-defined narrowing axes the visual
filter exposes (in addition to the always-on `assignee` axis). Empty `[]`
means assignee is the only axis — the GitHub default. See §6.

**`labelTemplate`** computes the default project display name from a
config dict (`owner/repo`, `org/project`, etc.). Pass `null` when the bare
type id is fine.

**`capabilities.creatableKinds`** is the canonical-`ItemKind` list the
"+ New item" form offers. Must be non-empty (the form needs a default);
the first entry is the default. The arch test
`src/__arch__/provider-creatable-kinds.test.ts` enforces both invariants.

**`capabilities.supportedReactions`** is the wire-level list of reaction
strings the provider accepts. Empty → the UI omits the reaction strip and
`addReaction` / `removeReaction` should be left unimplemented; non-empty →
both methods are required and must validate against this list.

**`itemNumberCodec`** translates between the URL-friendly item number
(`/items/42`) and the provider-native `Item.providerItemId` stored in the
cache. Required on every spec — items are routed by URL number, with no
fallback.

**`availableIntents`** lets the spec hide transition intents that would be
no-ops against a given canonical state for this provider (e.g. GitHub has
no native "open but not active" so `pause` from `active` is hidden).

---

## 6. Scope axes

Scope axes are how Docket narrows cached items without taking on
provider-specific knowledge in `src/core/`. They are **visual** (post-cache)
filters — sync always pulls everything the credentials see, and the visual
filter pipeline decides what gets shown. The `assignee` axis is always
present (every provider with assignment supports it); everything else is
declared by the spec.

When to add an axis:

- The provider exposes a stable narrowing dimension users actually filter
  by (team, project area, sprint, squad, component).
- The dimension's value is in `Item.providerRaw` after sync, or cheap to
  derive from cached fields.

When NOT to add an axis:

- For sort orders or display preferences (those are UI concerns).
- For values that change per-item without a stable enumeration — those
  belong in full-text search, not the chip bar.

Each axis carries:

- `key` — wire id stored in `SavedView` and sent over the tRPC wire.
- `label` — rendered to humans in saved-view editors and chip bars.
- `discoveryStage` — when set, names a discovery callback that lists
  candidate values for autocomplete. Set to `null` for free-form axes (the
  UI falls back to a plain text input). Always required; the field is
  nullable, not optional.

`axisMatcher` is the view-time predicate the visual filter calls for each
constrained axis:

```ts
export const acmeAxisMatcher: AxisMatcher = (item, axisKey, expected) => {
  const raw = item.providerRaw as { fields?: Record<string, unknown> } | null;
  const fields = raw?.fields;
  if (!fields || typeof fields !== "object") return false;
  if (axisKey === "squad") return fields.squad === expected;
  if (axisKey === "component") return fields.component === expected;
  return false; // unknown axis → narrow to nothing rather than silently widen
};
```

Returning `false` on unknown keys (rather than `true`) is the safe default
— a misconfigured filter narrows to nothing instead of silently dropping
the constraint.

`axisExtract` is the dual that powers chip-bar facet popovers — for each
cached item it returns the canonical value the item carries on that axis,
or `null` when the axis doesn't apply:

```ts
export const acmeAxisExtract: AxisExtractor = (item, axisKey) => {
  const raw = item.providerRaw as { fields?: Record<string, unknown> } | null;
  const fields = raw?.fields;
  if (!fields || typeof fields !== "object") return null;
  if (axisKey === "squad" || axisKey === "component") {
    const value = fields[axisKey];
    return typeof value === "string" && value ? value : null;
  }
  return null;
};
```

Both `axisMatcher` and `axisExtract` are required when `scopeAxes` is
non-empty.

---

## 7. NextAuth wiring

Sign-in flows for OAuth-backed providers go through NextAuth v5. The
dispatcher lives in `src/server/providers/auth-build.ts`:

```ts
import { azureDevOpsProvider } from "@/providers/azure-devops/auth";
import { acmeAuthProvider } from "@/providers/acme/auth";

export function buildAuthProvider(row: OauthProviderConfig): Provider {
  const clientSecret = decryptSecret(row.clientSecret);
  switch (row.kind) {
    case "github": return githubAuthProvider({ clientId: row.clientId, clientSecret, scopes: row.scopes });
    case "azure_devops": return azureDevOpsProvider({ clientId: row.clientId, clientSecret, ...(row.baseUrl ? { tenant: row.baseUrl } : {}), ...(row.scopes ? { extraScope: row.scopes } : {}) });
    case "acme": return acmeAuthProvider({ clientId: row.clientId, clientSecret });
    default: throw new UnknownOauthKindError(row.kind);
  }
}
```

The wrapper pattern (each provider exports a `<name>AuthProvider` from
`src/providers/<type-id>/auth.ts` that internally imports
`next-auth/providers/<x>`) keeps `buildAuthProvider` a pure switch — every
concrete `next-auth/providers/<x>` import lives next to the rest of its
provider package. The arch test `no-nextauth-provider-leak.test.ts`
whitelists `src/server/providers/auth-build.ts` AND `src/providers/<x>/**`
as the only callers allowed to import those concrete adapters; following
the wrapper pattern keeps the dispatcher trivial and the rules easy to
grep. `auth-build.ts` is also one of the few allowed importers of
`@/providers/<x>/...` (alongside `provider-registry.ts`,
`src/server/providers/build.ts`, sibling files inside the same provider
package, and the provider's own arch tests) — `no-router-provider-import.test.ts`
explicitly whitelists it.

The OAuth token NextAuth captures lands in `Account.access_token` for the
matching `provider` value. `src/server/providers/build.ts` reads it and
splices it into the spec factory's config as `accessToken`.

---

## 8. Registration

**In-tree (built-in):** append the spec to the `PROVIDER_SPECS` `as const`
tuple in `src/server/provider-registry.ts`. `ProviderTypeId` and
`PROVIDER_TYPE_IDS` are derived from the tuple, so adding a provider only
needs one edit here:

```ts
import { acmeSpec } from "@/providers/acme/spec";

export const PROVIDER_SPECS = [githubSpec, azureDevOpsSpec, acmeSpec] as const;
```

Then add the NextAuth case in `buildAuthProvider` (§7). That's it for
in-tree registration — the registry is intentionally a static tuple, not
an entry-point system. Third-party providers should fork or vendor.

---

## 9. Testing checklist

The bare minimum for a new provider:

| File | What it covers |
| --- | --- |
| `src/providers/<type-id>/state-map.test.ts` | `toCanonical` + `toNative` round-trip and edge cases. |
| `src/providers/<type-id>/provider.test.ts` (recommended) | Vitest mocking the SDK, exercise `listChangesSince` / `getItem` / `transition`, assert canonical types come out with `providerKey` stamped. |

Architectural guards that should keep passing without changes:

- `src/__arch__/no-router-provider-import.test.ts` — fails if you
  accidentally import your concrete provider from a router or service.
- `src/__arch__/no-provider-write-leak.test.ts` — fails if any file
  outside `src/server/proposals/executor.ts` and your own provider package
  starts calling provider write methods.
- `src/__arch__/no-nextauth-provider-leak.test.ts` — fails if a
  concrete `next-auth/providers/<name>` import lands anywhere outside
  `src/server/providers/auth-build.ts` or `src/providers/<x>/**`.
- `src/__arch__/no-octokit-leak.test.ts` (GitHub-specific equivalent) —
  if you bring in a vendor SDK with similar leak risk, add a sibling test
  scoped to your provider's package.
- `src/__arch__/tool-registration-order.test.ts` — fails if your provider
  somehow shifted the agent's tool registration order.

When in doubt, copy a sibling test and rename. The GitHub provider's
state-map test is the smallest reference.

---

## 10. End-to-end verification

Once everything's wired:

```bash
pnpm check                       # biome + tsc + vitest run
pnpm dev                         # next dev (Turbopack) + auto-seed
```

Then through the UI:

1. Visit `/settings` → OAuth providers and add a new row for your provider kind
   (or set `DEV_<KIND>_CLIENT_ID` + `DEV_<KIND>_CLIENT_SECRET` in
   `.env.local` and let the bootstrap seed write it on the next boot).
2. Sign in via the new OAuth provider.
3. Create a project pointing at the new provider's scope.
4. Run sync — the items list should populate from your provider.
5. Open an item, propose a transition, confirm — exercises the proposal
   builder + executor + state-map round-trip end-to-end.

If a UI surface shows a provider-native field name where you expected your
axis label, that's a missed leak — file it.

---

## Reference

- `src/core/provider.ts` — `WorkItemProvider`, `ProviderSpec`,
  `ScopeAxis`, `SetupField`, `LabelTemplate`, `AxisMatcher`,
  `AxisExtractor`, `ProviderError`/`ProviderUnreachableError`/`ProviderAuthError`.
- `src/core/types.ts` — `Item`, `ItemKind`, `ItemState`,
  `TransitionIntent`, `CreateFields`, `Comment`, `PullRequestDetail`,
  `PullRequestDiff`, `CommitDetail`, `CIStatus`, `PRMatch`,
  `CodeSearchResult`.
- `src/server/provider-registry.ts` — `PROVIDER_SPECS`, `getProviderSpec`,
  `listProviderSpecs`.
- `src/server/providers/build.ts` — `buildProviderForUser` (work-item
  side; reads `Account.access_token`).
- `src/server/providers/auth-build.ts` — `buildAuthProvider` (NextAuth
  side; reads `OauthProviderConfig`).
- `src/providers/github/` and `src/providers/azure-devops/` — reference
  implementations.
