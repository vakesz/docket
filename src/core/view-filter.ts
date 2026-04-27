/**
 * Pure view-filter: post-cache narrowing.
 *
 * Sync pulls everything the credentials see; this module decides what
 * actually renders for a given saved view. State bucket, assignees, and
 * provider-specific axes are all visual (post-cache) — there is no
 * server-side filter pushdown to the provider, by design (the cache is the
 * boundary, providers see whole-scope queries).
 *
 * Pure module, no I/O, no Prisma — drives both the items page on the server
 * (where the row is the Prisma `Item` shape) and any other surface that
 * holds canonical `Item` rows. The arch test forbids importing from
 * `@/server/**` or `@/providers/**` here; provider-specific axis matching
 * goes through `ProviderSpec.axisMatcher`, which is the indirection that
 * lets `core/` stay provider-agnostic.
 */

import type { AxisMatcher } from "@/core/provider";
import type { Item, ItemState, StateBucket } from "@/core/types";

/**
 * Canonical ItemState membership per state bucket. The `open` bucket covers
 * every "actively in someone's work tray" state (including soft tags like
 * blocked/needs_info that some providers encode as tags rather than native
 * states); `closed` covers terminal states. `all` is intentionally not
 * listed — its filter is "no filter."
 */
export const STATE_BUCKET_MEMBERS: Readonly<
  Record<Exclude<StateBucket, "all">, readonly ItemState[]>
> = {
  open: ["new", "active", "blocked", "needs_info"],
  closed: ["resolved", "closed"],
};

/**
 * Selection a SavedView resolves to at filter time. Mirrors the SavedView
 * Prisma row but without the row's persistence/identity fields, so the
 * filter consumes data from any source (DB row, URL query, in-memory
 * default) without an adapter layer.
 *
 * `axes` keys map to `ProviderSpec.scopeAxes[].key`; empty-string values
 * are treated as "no constraint" by the matcher contract.
 */
export type ViewFilter = {
  stateBucket: StateBucket;
  assignees: readonly string[];
  axes: Readonly<Record<string, string>>;
};

export const EMPTY_VIEW_FILTER: ViewFilter = {
  stateBucket: "open",
  assignees: [],
  axes: {},
};

/**
 * Narrow `items` to those whose canonical state belongs to `bucket`.
 * `bucket === "all"` is the identity. Use this directly when an upstream
 * has already constrained one of the other axes (e.g. SQL pre-filter).
 */
export function filterByStateBucket<T extends Pick<Item, "state">>(
  items: readonly T[],
  bucket: StateBucket,
): T[] {
  if (bucket === "all") return items.slice();
  const allowed = new Set<string>(STATE_BUCKET_MEMBERS[bucket]);
  return items.filter((item) => allowed.has(item.state));
}

/**
 * Narrow to items whose `assignee` matches one of `assignees`. Empty list
 * = no filter. An empty string in `assignees` matches items where assignee
 * is null (the "unassigned" bucket).
 */
export function filterByAssignees<T extends Pick<Item, "assignee">>(
  items: readonly T[],
  assignees: readonly string[],
): T[] {
  if (assignees.length === 0) return items.slice();
  const wantUnassigned = assignees.includes("");
  const set = new Set(assignees.filter((a) => a !== ""));
  return items.filter((item) => {
    if (item.assignee === null || item.assignee === undefined) {
      return wantUnassigned;
    }
    return set.has(item.assignee);
  });
}

/**
 * Narrow by provider-specific axes via the spec's `axisMatcher`. Empty
 * `axes` (or all empty values) is the identity. Items must satisfy *every*
 * declared axis (AND semantics across axes — the surface picks one value
 * per axis, the row has to match all of them).
 *
 * `matcher === null` is allowed and treated as "axes don't apply" (returns
 * items unchanged); that matches the contract on `ProviderSpec` where a
 * spec with empty `scopeAxes` carries `axisMatcher: null`.
 */
export function filterByAxes(
  items: readonly Item[],
  axes: Readonly<Record<string, string>>,
  matcher: AxisMatcher | null,
): Item[] {
  if (matcher === null) return items.slice();
  const entries = Object.entries(axes).filter(([, v]) => v !== "");
  if (entries.length === 0) return items.slice();
  return items.filter((item) => entries.every(([key, expected]) => matcher(item, key, expected)));
}

/**
 * Apply a complete view filter — bucket → assignees → axes. The chain is
 * left-to-right; each step narrows the set passed to the next. State and
 * assignee live on the canonical `Item` row, so they don't need the
 * matcher; axes do.
 */
export function applyViewFilter(
  items: readonly Item[],
  view: ViewFilter,
  matcher: AxisMatcher | null,
): Item[] {
  return filterByAxes(
    filterByAssignees(filterByStateBucket(items, view.stateBucket), view.assignees),
    view.axes,
    matcher,
  );
}
