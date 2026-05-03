/**
 * Pure helpers for AzDO pull-request linking — vstfs URL parsing, PR-id
 * parsing, and `PullRequestStatus` / `IdentityRefWithVote.vote` mapping.
 *
 * Kept separate from `provider.ts` so the parsers stay testable without
 * the SDK shim. The numeric enum mirrors live in `./constants.ts`.
 */

import type { PRState } from "@/core/types";
import { AZDO_PR_STATUS, AZDO_REVIEWER_VOTE } from "@/providers/azure-devops/constants";

export type VstfsPRRef = {
  projectId: string;
  repoId: string;
  pullRequestId: number;
};

const VSTFS_RE = /^vstfs:\/\/\/Git\/PullRequestId\/([^/]+)%2F([^/]+)%2F(\d+)$/i;
const WEB_PR_RE = /\/pullrequest\/(\d+)(?:[?#].*)?$/i;

/**
 * Parse a `vstfs:///Git/PullRequestId/<projectId>/<repoId>/<n>` artifact URL.
 *
 * AzDO emits these URL-encoded (segments separated by `%2F`, not `/`). The
 * SDK preserves that encoding in `relations[].url`. Returns null on any
 * malformed input — callers should treat null as "skip this relation"
 * rather than throwing, because one weird link should not blank the whole
 * result set.
 */
export function parseVstfsPRRef(url: string): VstfsPRRef | null {
  const m = VSTFS_RE.exec(url.trim());
  if (!m) return null;
  const projectId = decodeURIComponent(m[1] ?? "");
  const repoId = decodeURIComponent(m[2] ?? "");
  const pr = Number.parseInt(m[3] ?? "", 10);
  if (!projectId || !repoId || !Number.isFinite(pr)) return null;
  return { projectId, repoId, pullRequestId: pr };
}

/**
 * Pull a numeric PR id out of either:
 *  - a plain numeric string (`"123"`)
 *  - an AzDO web URL (`.../pullrequest/123`)
 *  - a vstfs artifact URL
 *
 * The agent receives `PRMatch.url` from `findRelatedPRs` (a web URL); accept
 * the bare number too so callers can short-circuit when they already know it.
 */
export function parseAzdoPullRequestId(input: string): number | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    return Number.isFinite(n) ? n : null;
  }
  const vstfs = parseVstfsPRRef(trimmed);
  if (vstfs) return vstfs.pullRequestId;
  const web = WEB_PR_RE.exec(trimmed);
  if (web) {
    const n = Number.parseInt(web[1] ?? "", 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Map AzDO's numeric `PullRequestStatus` enum to the canonical PR state
 * strings the rest of the app uses (`"open" | "closed" | "merged"`).
 *
 * `0/NotSet` and `4/All` are not real PR states; they fall through to
 * `"open"` so we don't surface a blank state field — callers can re-fetch
 * if they need certainty.
 */
export function pullRequestStatusToCanonical(status: number | undefined | null): PRState {
  if (status === AZDO_PR_STATUS.Completed) return "merged";
  if (status === AZDO_PR_STATUS.Abandoned) return "closed";
  return "open";
}

/**
 * Map AzDO's reviewer `vote` values onto canonical review states. Collapse
 * to APPROVED / CHANGES_REQUESTED / COMMENTED so the canonical type stays
 * consistent with the GitHub provider.
 */
export function voteToReviewState(vote: number | undefined | null): string {
  if (vote === AZDO_REVIEWER_VOTE.Approved || vote === AZDO_REVIEWER_VOTE.ApprovedWithSuggestions) {
    return "APPROVED";
  }
  if (vote === AZDO_REVIEWER_VOTE.Rejected || vote === AZDO_REVIEWER_VOTE.WaitingForAuthor) {
    return "CHANGES_REQUESTED";
  }
  return "COMMENTED";
}

const REF_PREFIX = "refs/heads/";

/** Strip the `refs/heads/` prefix from an AzDO branch ref. */
export function stripRefPrefix(ref: string | undefined | null): string {
  if (!ref) return "";
  return ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref;
}

/**
 * AzDO `VersionControlChangeType` is a flag enum; collapse to the canonical
 * `added | modified | removed | renamed` strings the `PullRequestFile` type
 * uses. Values: 1=add, 2=edit, 4=rename, 8=delete (others are flags we treat
 * as "modified" by default).
 */
export function changeTypeToStatus(changeType: number | undefined | null): string {
  if (changeType == null) return "modified";
  if ((changeType & 4) !== 0) return "renamed";
  if ((changeType & 8) !== 0) return "removed";
  if ((changeType & 1) !== 0) return "added";
  return "modified";
}
