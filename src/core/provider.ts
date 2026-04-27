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
  CIStatus,
  CodeSearchResult,
  Comment,
  CommitDetail,
  CreateFields,
  Item,
  ItemKind,
  PRMatch,
  PullRequestDetail,
  PullRequestDiff,
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
export interface WorkItemProvider {
  healthCheck(): Promise<void>;

  listChangesSince(watermark: Date | null): AsyncIterable<Item>;

  getItem(id: string): Promise<Item>;

  getComments(id: string): Promise<Comment[]>;

  getLinked(id: string): Promise<Item[]>;

  transition(id: string, intent: TransitionIntent): Promise<Item>;

  patchDescription(id: string, newMd: string): Promise<Item>;

  uploadAttachment(
    id: string,
    filename: string,
    content: Uint8Array,
    contentType: string,
  ): Promise<string>;

  addComment(id: string, bodyMd: string): Promise<Comment>;

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
   * Provider-native code search.
   *
   * Returns repository-scoped hits for `query`. Implementations should cap
   * results at `limit` (or a sensible internal cap when omitted) so the
   * agent doesn't drown in results for a vague query. Throw a
   * `ProviderError` when the provider doesn't expose code search.
   */
  searchCode?(query: string, limit: number): Promise<CodeSearchResult>;
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
 * `supportedKinds` is the ordered set of kinds this provider can create;
 * surfaces render it as the choices in the new-item picker. It does not
 * gate reads (cached items already carry a translated `ItemKind`).
 *
 * `scopeAxes` declares the provider-defined narrowing axes alongside the
 * reserved `assignee`, `state`, and `tags` chips. Empty `[]` means only the
 * reserved chips render.
 *
 * `axisMatcher` and `axisExtract` must both be set whenever `scopeAxes` is
 * non-empty — if you can match an axis you can extract it.
 */
export type ProviderSpec = {
  typeId: string;
  displayName: string;
  factory: ProviderFactory;
  setupFields: readonly SetupField[];
  requiresCli: readonly string[];
  grouping: GroupingStrategy;
  supportedKinds: readonly ItemKind[];
  normalizeConfig: ProviderConfigNormalizer | null;
  labelTemplate: LabelTemplate | null;
  scopeAxes: readonly ScopeAxis[];
  axisMatcher: AxisMatcher | null;
  axisExtract: AxisExtractor | null;
};
