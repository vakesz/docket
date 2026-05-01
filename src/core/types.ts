/**
 * Canonical domain types — provider-agnostic.
 *
 * Everything in this module is pure TS and has no runtime dependencies. The
 * arch test in `src/core/__arch__.test.ts` enforces that nothing here imports
 * from `src/providers/**`, `src/server/**`, or `src/agent/**`.
 *
 * String-literal-union enums are exposed as both an `as const` array (for
 * runtime iteration / Zod consumption) and a derived type (for compile-time
 * narrowing). One source, no drift.
 */

/**
 * Branded id types. Plain strings at runtime, but the compiler refuses to
 * mix a `UserId` where a `ProjectId` is expected. The brand is attached at
 * the access boundary (`projectForUser`, the project-membership middleware,
 * session resolution); inside the system it flows through tRPC ctx and the
 * proposal executor without further casts. Prisma `where` clauses accept
 * the branded value transparently because brands are subtypes of `string`.
 */
declare const __brand: unique symbol;
export type ProjectId = string & { readonly [__brand]: "ProjectId" };
export type UserId = string & { readonly [__brand]: "UserId" };
export type ProposalId = string & { readonly [__brand]: "ProposalId" };

export const asProjectId = (value: string): ProjectId => value as ProjectId;
export const asUserId = (value: string): UserId => value as UserId;
export const asProposalId = (value: string): ProposalId => value as ProposalId;

export const ITEM_KINDS = ["epic", "feature", "story", "task", "bug"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export function isItemKind(value: string): value is ItemKind {
  return (ITEM_KINDS as readonly string[]).includes(value);
}

export const ITEM_STATES = [
  "new",
  "active",
  "blocked",
  "needs_info",
  "resolved",
  "closed",
] as const;
export type ItemState = (typeof ITEM_STATES)[number];

export function isItemState(value: string): value is ItemState {
  return (ITEM_STATES as readonly string[]).includes(value);
}

export const TRANSITION_INTENTS = [
  "start_work",
  "pause",
  "block",
  "needs_info",
  "close_done",
  "close_wontfix",
  "reopen",
] as const;
export type TransitionIntent = (typeof TRANSITION_INTENTS)[number];

export function isTransitionIntent(value: string): value is TransitionIntent {
  return (TRANSITION_INTENTS as readonly string[]).includes(value);
}

/**
 * Canonical "intents that move an item out of where it is" per state.
 *
 * Used as the upper bound for what a provider's UI can offer. Providers
 * that can't represent every intent against every state (e.g. GitHub has
 * no distinct "paused" vs "active" open state) trim further in their own
 * `availableIntents` implementation.
 */
export function canonicalIntentsFor(state: ItemState): readonly TransitionIntent[] {
  switch (state) {
    case "new":
      return ["start_work", "block", "needs_info", "close_done", "close_wontfix"];
    case "active":
      return ["pause", "block", "needs_info", "close_done", "close_wontfix"];
    case "blocked":
      return ["start_work", "needs_info", "close_done", "close_wontfix"];
    case "needs_info":
      return ["start_work", "block", "close_done", "close_wontfix"];
    case "resolved":
    case "closed":
      return ["reopen"];
  }
}

export const STATE_BUCKETS = ["open", "closed", "all"] as const;
export type StateBucket = (typeof STATE_BUCKETS)[number];

/**
 * Backlog filter bucket — superset of `StateBucket` plus the cache-only
 * `"archived"` bucket. Saved views still store the narrower `StateBucket`
 * (archived isn't a canonical state). The items router maps each backlog
 * bucket to a (state-clause, archived-flag) pair before querying.
 */
export const BACKLOG_BUCKETS = ["open", "closed", "archived", "all"] as const;
export type BacklogBucket = (typeof BACKLOG_BUCKETS)[number];

export type Attachment = {
  filename: string;
  url: string | null;
};

/**
 * Reaction count summary, keyed by an opaque provider-declared identifier.
 *
 * Core deliberately does NOT enumerate reaction kinds — the set differs by
 * provider (GitHub has eight emoji shortcodes; another provider might use a
 * shop of award emoji, or numeric vote tallies). Providers expose their
 * supported set via `ProviderSpec.capabilities.supportedReactions`; surfaces
 * (UI, agent tools) read from that list rather than a core-pinned enum.
 *
 * Missing keys mean zero; `{}` means "no reactions yet on a provider that
 * supports them". `null` (only valid where this type is `Reactions | null`)
 * means "provider does not model reactions".
 */
export type Reactions = Partial<Record<string, number>>;

/**
 * Cached canonical work item. The provider boundary translates native types
 * into this shape; nothing downstream sees provider-native state strings
 * (those live in `providerRaw` for the rare consumer that needs them).
 *
 * `providerKey` is stamped at the storage boundary so the shared cache can
 * be filtered to the active provider.
 */
export type Item = {
  id: string;
  kind: ItemKind;
  title: string;
  description: string;
  state: ItemState;
  assignee: string | null;
  /**
   * Canonical plural assignee list. Providers without multi-assignee fill
   * `[assignee]` when assignee is non-null, `[]` otherwise. Surfaces should
   * migrate to reading this over `assignee` (singular) over time.
   */
  assignees?: string[];
  /**
   * Optional reviewer logins (e.g. GitHub PR requested_reviewers). Empty on
   * providers that don't model reviewers.
   */
  reviewers?: string[];
  /**
   * Provider-native ids of items linked to this one (cross-references, AzDO
   * relations). Empty when the provider doesn't surface linked items.
   */
  linkedItemIds?: string[];
  parentId: string | null;
  tags: string[];
  /**
   * Reaction counts. `null` = provider doesn't model reactions; `{}` = no
   * reactions yet on a provider that does.
   */
  reactions?: Reactions | null;
  /**
   * Canonical milestone label (free-text). Null when the provider doesn't
   * model milestones or none is set.
   */
  milestone?: string | null;
  /** Canonical sprint/iteration label. Null when not modelled. */
  iteration?: string | null;
  /** Canonical area / component label. Null when not modelled. */
  area?: string | null;
  /** Latest CI summary on the item's linked ref, when surfaced. */
  ciSummary?: { state: "success" | "failure" | "pending"; url: string | null } | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  /** Provider-side closure timestamp. Null while open or unsupported. */
  closedAt?: Date | null;
  url: string | null;
  author: string | null;
  /**
   * Repository the item is primarily associated with, when the provider can
   * attest to it (GitHub knows; Azure DevOps generally can't surface a
   * reliable repo pointer in a work item's payload, so it stays null there).
   */
  repositoryUrl: string | null;
  attachments: Attachment[];
  providerRaw: Record<string, unknown>;
  providerKey: string;
};

export type Comment = {
  id: string;
  itemId: string;
  author: string;
  body: string;
  createdAt: Date;
  /** Last-touched timestamp from the provider; null when not surfaced. */
  updatedAt?: Date | null;
  /** True when provider reports the comment was edited after creation. */
  edited?: boolean;
  /** Reaction counts. `null` = unsupported on this provider. */
  reactions?: Reactions | null;
};

/**
 * A fully-hydrated change set for one item, yielded by
 * `WorkItemProvider.listChangesSince`. Sync upserts the item plus its
 * comments in one pass so the cache stays fresh on both fronts without a
 * second round-trip.
 *
 * Providers that can't fetch comments cheaply for every change may yield an
 * empty `comments` array; the cache then keeps whatever it last saw for
 * that item. `comments: null` means "skip comment reconciliation for this
 * item" (e.g. provider listing returned an item where comments are
 * known-unchanged); `[]` means "no comments exist".
 */
export type ChangedItem = {
  item: Item;
  comments: Comment[] | null;
};

export type Conversation = {
  id: string;
  itemId: string;
  startedAt: Date;
  archivedAt: Date | null;
  tokensIn: number;
  tokensOut: number;
  costCents: number;
};

export type CreateFields = {
  title: string;
  description: string;
  parentId: string | null;
  assignee: string | null;
  tags: string[];
};

export type SyncSummary = {
  upserted: number;
  archived: number;
  watermark: Date | null;
};

/**
 * A pull request that might be related to a work item.
 *
 * `confidence` is a soft hint (0.0–1.0) the provider attaches based on how
 * strong the signal was — direct id mention in title > mention in body >
 * keyword overlap. The agent uses it to decide whether a match is worth
 * surfacing as a link-back proposal.
 */
export type PRMatch = {
  url: string;
  title: string;
  branch: string;
  /** "open" | "merged" | "closed" — provider-specific labels OK. */
  state: string;
  author: string;
  confidence: number;
};

export type PullRequestFile = {
  path: string;
  /** added | modified | removed | renamed */
  status: string;
  additions: number;
  deletions: number;
};

export type PullRequestReview = {
  author: string;
  /** APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED */
  state: string;
  body: string;
  submittedAt: Date | null;
};

/**
 * Full detail view of a pull request — body, state, labels, files, reviews.
 *
 * Kept flat and JSON-ready because the agent tool layer immediately
 * serializes this to a tool response. `files` may be a subset (typically
 * the first page) if the PR touches many files — the tool description
 * documents the cap.
 */
export type PullRequestDetail = {
  /** owner/name#NN — same shape as item ids. */
  id: string;
  url: string;
  title: string;
  number: number;
  /** "open" | "closed" | "merged" */
  state: string;
  author: string;
  body: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  labels: string[];
  requestedReviewers: string[];
  additions: number;
  deletions: number;
  changedFiles: number;
  files: PullRequestFile[];
  reviews: PullRequestReview[];
  commentsCount: number;
  reviewCommentsCount: number;
  updatedAt: Date | null;
};

export type CommitDetail = {
  sha: string;
  url: string;
  author: string;
  authorEmail: string;
  committer: string;
  committedAt: Date | null;
  message: string;
  parents: string[];
  additions: number;
  deletions: number;
  files: PullRequestFile[];
};

/**
 * One CI run / check — generic across GitHub checks and ADO pipelines.
 *
 * `status` is where the run is (queued | in_progress | completed).
 * `conclusion` is only meaningful once `status === "completed"`
 * (success | failure | cancelled | skipped | neutral | timed_out).
 */
export type CIRun = {
  id: string;
  name: string;
  status: string;
  conclusion: string;
  url: string;
  headSha: string;
  startedAt: Date | null;
  completedAt: Date | null;
};

export const CI_OVERALL = ["success", "failure", "pending", "none"] as const;
export type CIOverall = (typeof CI_OVERALL)[number];

export type CIStatus = {
  ref: string;
  overall: CIOverall;
  runs: CIRun[];
};

/**
 * Per-file unified diff for a pull request — the same files list returned
 * by `getPullRequest`, augmented with each file's patch text.
 *
 * `patch` is null when the provider declines to surface it (binary files,
 * files past a size cap, or generated content). The agent treats null as
 * "patch unavailable" rather than empty.
 */
export type PullRequestDiff = {
  id: string;
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string | null;
  }>;
};

/**
 * One code-search hit — path inside a repository plus the live URL.
 *
 * Snippets are intentionally NOT modeled: GitHub gates them behind a
 * preview accept header, ADO doesn't expose them, and the agent already
 * has read tools to follow up on a path it cares about.
 */
export type CodeSearchHit = {
  /** owner/repo or equivalent identifier the provider uses for repo scope. */
  repository: string;
  path: string;
  /** Full HTML URL the user can click to read the file. */
  url: string;
};

export type CodeSearchResult = {
  query: string;
  total: number;
  items: CodeSearchHit[];
};

/**
 * A named provider. `id` is the `providerKey` — memory, sources,
 * sub-agents, and MCP servers are keyed by provider, not by scope.
 *
 * Scopes live on the provider as visual filters: switching scope re-filters
 * what's shown from the cache but keeps the same project context (same
 * memory, same sources, same MCP fleet). Items assigned to the user can
 * link to items assigned to someone else — both belong in the same project.
 */
export type Project = {
  id: string;
  providerKey: string;
  name: string;
  description: string;
  createdAt: Date | null;
  archivedAt: Date | null;
};

/**
 * A single per-project memory note.
 *
 * Memory is the agent's durable knowledge of a project (glossary terms,
 * design decisions, conventions). Bodies are plain Markdown so a human can
 * read and edit them. `source` distinguishes user-authored ("user") from
 * agent-staged-and-confirmed ("agent") entries — both are equally durable;
 * the field is just informational.
 */
export type MemoryEntry = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  tags: string[];
  /** "user" | "agent" — informational, no behavior depends on it. */
  source: string;
  createdAt: Date | null;
  updatedAt: Date | null;
};

/**
 * A single per-project reference document.
 *
 * Sources are human-curated long-form material the agent can read on demand
 * (requirements, runbooks, design docs). The agent has read-only access —
 * there is no `proposeSource*` flow. `kind` is free-text; neither it nor
 * `uri` is interpreted by docket itself.
 */
export type Source = {
  id: string;
  projectId: string;
  title: string;
  body: string;
  kind: string;
  uri: string;
  tags: string[];
  createdAt: Date | null;
  updatedAt: Date | null;
};
