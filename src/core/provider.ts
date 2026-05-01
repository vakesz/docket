/**
 * Provider-agnostic interface for work-item systems.
 *
 * The `WorkItemProvider` shape — and everything around it (specs, axes,
 * setup fields, factories) — lives in `src/core/` so it can be referenced by
 * the registry, by tRPC routers, and by the agent loop without dragging any
 * concrete provider in. Concrete provider modules in `src/providers/<name>/`
 * import these types and implement them; the arch test forbids the reverse.
 */

import type {
  ChangedItem,
  CIStatus,
  CodeSearchResult,
  Comment,
  CommitDetail,
  CreateFields,
  Item,
  ItemKind,
  ItemState,
  PRMatch,
  PullRequestDetail,
  PullRequestDiff,
  Reactions,
  TransitionIntent,
} from "@/core/types";

/**
 * View-time matcher for a single scope-axis value against a cached item.
 *
 * Receives `(item, axisKey, expected)` and returns true when the item should
 * be included. Providers register one matcher per spec covering every axis
 * they declare in `scopeAxes`; the visual-filter layer iterates declared
 * axes and calls the matcher for whichever ones the user constrained. Empty
 * string is treated as "don't filter" before the matcher is invoked, so
 * matchers can assume `expected` is a concrete value.
 */
export type AxisMatcher = (item: Item, axisKey: string, expected: string) => boolean;

/**
 * View-time value extractor for a single scope-axis on a cached item.
 *
 * Receives `(item, axisKey)` and returns the canonical string value the
 * item carries for that axis (or null if absent). The visual-filter layer
 * calls this once per cached item per declared axis to populate the chip
 * popovers (top-N values + counts). Implementations read from
 * `item.providerRaw` so `core/` stays provider-agnostic — the same place
 * `axisMatcher` looks. Return null for items the axis doesn't apply to;
 * the facet computation skips nulls rather than counting them as a value.
 */
export type AxisExtractor = (item: Item, axisKey: string) => string | null;

/**
 * Base class for provider-layer errors surfaced to core.
 *
 * Subclasses are checked with `instanceof` at the boundary so callers can
 * react differently to "remote down" vs "creds rejected" without brittle
 * string matching.
 */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Remote system is unreachable. Per plan §13, fail fast — do not silently degrade. */
export class ProviderUnreachableError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnreachableError";
  }
}

/** Credentials are missing or rejected. The wizard should re-run the relevant step. */
export class ProviderAuthError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = "ProviderAuthError";
  }
}

/**
 * Translate a thrown error from a provider HTTP client into the canonical
 * `ProviderError` subclass. Centralised so every provider classifies the same
 * way: 401/403 → auth, 5xx → unreachable, network/DNS/timeout → unreachable,
 * everything else → generic. `label` prefixes the message so logs and the UI
 * show which provider raised it. Always throws — typed `never` so callers
 * read as `wrapProviderError(err, "GitHub")` in a `catch` block.
 */
const NETWORK_ERROR_RE = /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i;

export function wrapProviderError(err: unknown, label: string): never {
  const status =
    (err as { statusCode?: number; status?: number } | null)?.statusCode ??
    (err as { status?: number } | null)?.status ??
    null;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 401 || status === 403) {
    throw new ProviderAuthError(`${label} auth rejected: ${message}`);
  }
  if (typeof status === "number" && status >= 500) {
    throw new ProviderUnreachableError(`${label} upstream error: ${message}`);
  }
  if (err instanceof Error && NETWORK_ERROR_RE.test(err.message)) {
    throw new ProviderUnreachableError(`${label} unreachable: ${message}`);
  }
  throw new ProviderError(message);
}

/**
 * Provider-agnostic interface for work-item systems.
 *
 * All canonical-model instances returned from here have provider-specific
 * state strings already translated into `ItemState`. Providers MUST NOT
 * leak raw provider state through this interface — that's what
 * `Item.providerRaw` is for.
 *
 * The PR / commit / CI methods are optional in the sense that providers
 * which don't have the concept can throw `ProviderError` ("not supported
 * for this provider"); the agent tools that call them treat such throws
 * as "skip this signal" rather than a hard failure.
 */
/**
 * Target of a reaction proposal: the item itself or one of its comments.
 *
 * `id` is the provider-native id (item id or comment id). For `kind: "comment"`,
 * the comment id is scoped under its item — providers that need both look up
 * the parent item via the cached `Comment.itemId` join.
 */
export type ReactionTarget = { kind: "item" | "comment"; id: string };

export interface WorkItemProvider {
  healthCheck(): Promise<void>;

  /**
   * Stream changes since the watermark as fully-hydrated bundles (item +
   * comments). Sync upserts both in a single pass. Providers that can't
   * cheaply fetch comments for every changed item may yield bundles with
   * `comments: null` ("skip comment reconciliation") or `[]` ("no comments
   * exist"). Reactions on the item and on each comment ride along inside
   * the canonical `Item.reactions` / `Comment.reactions` fields.
   */
  listChangesSince(watermark: Date | null): AsyncIterable<ChangedItem>;

  getItem(id: string): Promise<Item>;

  getComments(id: string): Promise<Comment[]>;

  getLinked(id: string): Promise<Item[]>;

  transition(id: string, intent: TransitionIntent): Promise<Item>;

  patchDescription(id: string, newDescription: string): Promise<Item>;

  uploadAttachment(
    id: string,
    filename: string,
    content: Uint8Array,
    contentType: string,
  ): Promise<string>;

  addComment(id: string, body: string): Promise<Comment>;

  createItem(kind: ItemKind, fields: CreateFields): Promise<Item>;

  /**
   * Replace the item's user-facing tag set.
   *
   * Implementations MUST preserve any labels/tags they use to encode soft
   * canonical states (blocked, needs-info, wontfix). The executor passes the
   * full target set excluding state-encoding labels; the provider unions in
   * whatever it currently uses for state encoding before writing. That keeps
   * `setTags` from accidentally clearing a `blocked` tag and silently
   * flipping the canonical state to `active`.
   */
  setTags(id: string, tags: readonly string[]): Promise<Item>;

  /**
   * Replace the item's assignee.
   *
   * `assignee` is the provider-native identity string the provider stamps
   * into `Item.assignee` (e.g. a GitHub login or an Azure DevOps email/UPN).
   * `null` clears the assignment. Implementations must accept the same
   * string they emit on reads — no normalization on the caller side — and
   * return the refreshed canonical `Item`.
   */
  setAssignee(id: string, assignee: string | null): Promise<Item>;

  /**
   * The string the provider stamps into `Item.assignee` for "me".
   *
   * Lets the surface-level `@me` visual filter match cached rows. Providers
   * that can't resolve their own identity cheaply may return null; `@me`
   * then degrades to "no filter" (everything the user can see).
   */
  currentUserIdentity(): Promise<string | null>;

  // PR / commit / CI surface — used by the agent's readonly tool group.
  // Providers that have no PR concept may throw `ProviderError`; tool
  // wrappers treat that as "no PRs surfaced" rather than a hard failure.
  findRelatedPRs?(id: string): Promise<PRMatch[]>;
  getPullRequest?(prId: string): Promise<PullRequestDetail>;
  getPullRequestDiff?(prId: string): Promise<PullRequestDiff>;
  getCommit?(sha: string): Promise<CommitDetail>;
  getCIStatus?(ref: string): Promise<CIStatus>;

  /**
   * Project-wide PR keyword search. Used as a fallback when
   * `findRelatedPRs` returns no link-driven matches — a PR may have been
   * merged without ever referencing the issue. Implementations cap the
   * result set at `limit` (or a sensible internal cap) and return matches
   * at low confidence (no explicit link signal). Throw `ProviderError`
   * when the provider doesn't expose PR keyword search.
   */
  searchPullRequests?(
    query: string,
    opts: { state: "open" | "closed" | "merged" | "all"; limit: number },
  ): Promise<PRMatch[]>;

  /**
   * Provider-native code search.
   *
   * Returns repository-scoped hits for `query`. Implementations should cap
   * results at `limit` (or a sensible internal cap when omitted) so the
   * agent doesn't drown in results for a vague query. Throw a
   * `ProviderError` when the provider doesn't expose code search.
   */
  searchCode?(query: string, limit: number): Promise<CodeSearchResult>;

  /**
   * Add a reaction on the target. Only implemented by providers whose
   * `ProviderSpec.capabilities.supportedReactions` is non-empty. The
   * `reaction` string MUST be a member of that list — providers should
   * validate and throw `ProviderError` on unknown kinds. Returns the
   * post-write reaction summary so the proposal executor can refresh the
   * cache without a separate fetch.
   */
  addReaction?(target: ReactionTarget, reaction: string): Promise<{ reactions: Reactions }>;

  /**
   * Remove a reaction on the target. Same capability gate and validation
   * rules as `addReaction`. Returns the post-write reaction summary.
   */
  removeReaction?(target: ReactionTarget, reaction: string): Promise<{ reactions: Reactions }>;
}

export const SETUP_FIELD_KINDS = ["string", "url", "secret"] as const;
export type SetupFieldKind = (typeof SETUP_FIELD_KINDS)[number];

/**
 * One config field a provider asks the first-time wizard to collect.
 *
 * `kind: "url"` gets a URL validator in the frontend; `kind: "secret"` is
 * write-only and masked on display. All other fields are plain strings.
 */
export type SetupField = {
  key: string;
  label: string;
  kind: SetupFieldKind;
  required: boolean;
  placeholder: string;
  help: string;
};

/**
 * Constructs a live provider from `(config, displayName)`. Configs are
 * already validated and normalized by the time the factory sees them.
 */
export type ProviderFactory = (
  config: Record<string, unknown>,
  displayName: string,
) => WorkItemProvider;

/**
 * Normalizer called before a provider config is validated and persisted.
 *
 * Receives raw wizard/API input and returns a cleaned object (strip
 * whitespace, canonicalize URLs, fill template defaults). Throws with a
 * human-readable message on invalid input; callers relay it to the user.
 */
export type ProviderConfigNormalizer = (raw: Record<string, unknown>) => Record<string, unknown>;

/**
 * Build a human-readable display name from a provider's config.
 *
 * Used as the default for the display-name prompt in the first-run wizard
 * and in the suggest-label endpoint. The template reads only what's already
 * in `config` — no out-of-band hints — so any surface that calls it sees
 * the same result for the same config.
 *
 * Return an empty string when no useful label can be inferred; callers fall
 * back to the provider's `displayName` or the bare type id.
 */
export type LabelTemplate = (config: Record<string, unknown>) => string;

export const GROUPING_STRATEGIES = ["by_kind", "by_state_bucket"] as const;
export type GroupingStrategy = (typeof GROUPING_STRATEGIES)[number];

/**
 * Where the form's free-form "Base URL / tenant" input is persisted.
 *
 * `"baseUrl"`     — write straight into the `OauthProviderConfig.baseUrl`
 *                   column. GitHub Enterprise uses this slot to override
 *                   the OAuth endpoint.
 * `"metadataTenant"` — store under `metadata.tenant` in the JSONB column,
 *                      and clear `baseUrl`. Azure DevOps uses this slot for
 *                      the Entra tenant id.
 *
 * The router reads this off the registry instead of hardcoding `if (kind ===
 * "azure_devops")` so adding a new tenant-style provider is one new spec
 * entry — no router edit.
 */
export type OauthAuxSlot = "baseUrl" | "metadataTenant";

/**
 * OAuth-side metadata for a provider type that supports sign-in.
 *
 * Populated on `ProviderSpec.oauth` when the provider has a NextAuth
 * adapter wired (see `src/server/providers/auth-build.ts`). The fields are
 * pure data — no NextAuth or JSX leaks into core. Surfaces consume them to
 * pre-fill the OAuth-creds form, the bootstrap wizard, and the seed script.
 *
 * - `defaultLabel` / `defaultScopes` are the values that land in fresh rows.
 * - `baseUrlPlaceholder` is the human-readable hint for the optional
 *   per-row `baseUrl` column. Empty placeholder hides the field's hint.
 * - `baseUrlHelpKey` lets surfaces render a long-form help string keyed
 *   off the spec rather than re-encoding `if (kind === ...)` chains. Empty
 *   string means "no special help — generic baseUrl explanation only."
 * - `auxSlot` names the storage slot the form's "Base URL / tenant" field
 *   writes to (see `OauthAuxSlot`).
 */
export type ProviderOauthMetadata = {
  defaultLabel: string;
  defaultScopes: string;
  baseUrlPlaceholder: string;
  baseUrlHelpKey: string;
  auxSlot: OauthAuxSlot;
};

/**
 * Reaction kinds aside, `Item.author` and `Item.assignee` carry a
 * provider-stamped identifier. Some providers expose a stable public
 * profile URL (GitHub: `https://github.com/<login>`); others don't (AzDO
 * stamps null today). Surfaces call this via the spec to render an `<a>`
 * around the author chip — return null when the provider has no useful URL
 * shape so the UI degrades to plain text.
 */
export type ProviderProfileUrlBuilder = (identity: string) => string | null;

/**
 * Per-provider avatar fetcher signature.
 *
 * Mirrors `FetchAvatarOptions` / `FetchedAvatar` in `src/server/avatars/`
 * but typed via plain shapes so `core/` doesn't import server-only
 * modules. The actual server registry imports the spec, narrows to specs
 * with a non-null `avatarFetcher`, and dispatches to it.
 */
export type ProviderAvatarFetched = {
  bytes: Uint8Array;
  contentType: string;
  etag?: string | null;
};

export type ProviderAvatarFetcher = (
  identifier: string,
  opts: { accessToken?: string | null; isSelf?: boolean },
) => Promise<ProviderAvatarFetched | null>;

/**
 * One provider-defined axis for the visual scope filter.
 *
 * `key` is the wire/storage identifier persisted in the saved view's `axes`
 * map (e.g. `"area_path"`). `label` is rendered to humans. `discoveryStage`
 * — when set — names the wizard `discover` stage that lists candidate
 * values for this axis; callers wire datalist/combobox autocomplete against
 * it. Leave it null for free-form axes the provider can't enumerate.
 *
 * Assignee is intentionally NOT modeled as an axis — it has special `@me`
 * resolution against `WorkItemProvider.currentUserIdentity` and matches the
 * dedicated `Item.assignee` column rather than `providerRaw`.
 */
export type ScopeAxis = {
  key: string;
  label: string;
  discoveryStage: string | null;
};

/**
 * Static description of a provider type — what the registry knows about it.
 *
 * `factory` constructs a live provider from `(config, displayName)`.
 * `setupFields` and `requiresCli` are consumed by the setup surface so each
 * provider owns the shape of its own onboarding.
 *
 * `grouping` tells the UI how to arrange the backlog tree (see
 * `GroupingStrategy`). Defaulting to `"by_kind"` keeps the existing AzDO
 * behavior for any spec that doesn't explicitly opt in.
 *
 * `scopeAxes` declares the provider-defined narrowing axes alongside the
 * reserved `assignee`, `state`, and `tags` chips. Empty `[]` means only the
 * reserved chips render.
 *
 * `axisMatcher` and `axisExtract` must both be set whenever `scopeAxes` is
 * non-empty — if you can match an axis you can extract it.
 */
/**
 * Per-provider capability flags. The UI reads these to decide whether to
 * render reaction affordances, the PR diff link, etc. Keeps the
 * provider-agnostic story honest: features come from a registry-driven
 * capabilities map, not from `if (providerKind === 'github')` scattered
 * through views.
 */
/**
 * Translate between the URL-friendly item number the user sees in the address
 * bar and the provider-native id stored in `Item.providerItemId`.
 *
 * - GitHub stores `"acme/web#42"` but the project's `providerScope` already
 *   pins `{owner, repo}`, so the URL only carries `42`.
 * - Azure DevOps stores `"1234"`; the URL carries the same string.
 *
 * `parseItemNumber` rejects shapes the provider doesn't recognise (returns
 * null) so the items router can surface a 404 instead of forwarding garbage
 * into a `findFirst`. `formatItemNumber` is the inverse — it turns a stored
 * `providerItemId` back into the URL slot, so links generated from cached
 * rows agree with what the route expects.
 */
export type ProviderItemNumberCodec = {
  parseItemNumber: (scope: Record<string, unknown>, urlNumber: string) => string | null;
  formatItemNumber: (providerItemId: string) => string;
};

export type ProviderCapabilities = {
  /**
   * Reaction kinds the provider supports on items and comments. Empty array
   * means the provider doesn't model reactions at all (UI omits the
   * reaction strip entirely). The list is the wire format — values flow
   * straight through to `addReaction` / `removeReaction` and are stored as
   * keys in `Item.reactions` / `Comment.reactions`. Order is the order the
   * UI renders them in. Each provider declares its own set; core stays
   * agnostic.
   */
  supportedReactions: readonly string[];
  /** Provider exposes a CI run summary on the item's linked ref. */
  ciStatus: boolean;
  /** Provider exposes per-file unified diffs for PRs. */
  pullRequestDiffs: boolean;
  /** Provider surfaces explicit linked-item references (cross-refs,
   *  relations). When false, `Item.linkedItemIds` is always empty. */
  linkedItems: boolean;
  /**
   * Canonical item kinds this provider can create. The first entry is the
   * default the create form lands on; surfaces hide the kind selector when
   * the list is length 1. Must be non-empty — every provider has to declare
   * at least one creatable kind (the create form needs a default).
   *
   * Kinds reachable through sync but NOT in this list are still rendered
   * read-only in the cache; this is strictly about what `createItem` can
   * meaningfully translate. GitHub, which has no native kind concept, lists
   * `["task"]` because every issue rounds-trips back as `"task"` via
   * `inferKind`. Azure DevOps under the Agile template lists the full set.
   */
  creatableKinds: readonly ItemKind[];
  /**
   * Lowercased tag/label values the provider uses to encode canonical state
   * (e.g. GitHub's `blocked`/`needs-info`/`wontfix`). The provider's
   * `setTags` re-unions these in regardless of what the caller passes, so
   * the tag-editor surface filters them out of the editable set — otherwise
   * the diff would show a removal that never happens.
   */
  stateEncodingTags: readonly string[];
};

export type ProviderSpec = {
  typeId: string;
  displayName: string;
  factory: ProviderFactory;
  setupFields: readonly SetupField[];
  requiresCli: readonly string[];
  grouping: GroupingStrategy;
  normalizeConfig: ProviderConfigNormalizer | null;
  labelTemplate: LabelTemplate | null;
  scopeAxes: readonly ScopeAxis[];
  axisMatcher: AxisMatcher | null;
  axisExtract: AxisExtractor | null;
  /**
   * URL ↔ providerItemId codec. Required on every spec — items are routed
   * by their URL number, so there's nowhere to fall back to.
   */
  itemNumberCodec: ProviderItemNumberCodec;
  capabilities: ProviderCapabilities;
  /**
   * Transition intents the UI should expose from a given canonical state.
   *
   * The canonical-state-to-intent mapping is also gated by what each provider
   * can actually represent: e.g. GitHub has no native "open but not active"
   * state, so `pause` from canonical `active` collapses to a no-op and the UI
   * shouldn't offer it. Providers that can express the full intent set return
   * the canonical list; others trim entries that would produce no provider-
   * side change against the current snapshot.
   */
  availableIntents: (state: ItemState) => readonly TransitionIntent[];
  /**
   * OAuth sign-in metadata. `null` for providers that don't support OAuth
   * (CLI-only, API-token-only). The actual NextAuth adapter dispatch lives
   * in `src/server/providers/auth-build.ts` so JSX/NextAuth deps stay out
   * of `core/`.
   */
  oauth: ProviderOauthMetadata | null;
  /** Profile URL for an `Item.author` identity, or null if not available. */
  profileUrl: ProviderProfileUrlBuilder | null;
  /**
   * Optional public avatar fetcher. Providers that don't expose a useful
   * fetch (cross-user not cheaply available, etc.) leave this null and the
   * UI keeps showing initials. The signed-in user's own avatar is captured
   * during the OAuth callback regardless of this field.
   */
  avatarFetcher: ProviderAvatarFetcher | null;
};
