/**
 * Provider-internal tuning constants. These knobs drive Octokit calls and
 * are not currently exposed to operators — pagination size in particular
 * is constrained by GitHub's own per-page maximum (100), so there's no
 * deployment-tunable knob to add. Centralized here so a future change
 * (e.g. raising on a self-hosted GHE, splitting "default" from "search"
 * page sizes) lands in one file.
 */

/** GitHub REST default page size — also Octokit's hard maximum. */
export const PAGE_SIZE = 100;

/**
 * Page size for the `/search/issues` endpoint and similar search APIs.
 * GitHub caps these at 100 too, but we use 50 because search is rate-
 * limited far more aggressively than item listing — paying one extra
 * round-trip is cheaper than burning a search quota credit.
 */
export const SEARCH_PAGE_SIZE = 50;
