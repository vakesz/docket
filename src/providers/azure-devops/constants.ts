/**
 * Provider-internal tuning constants and AzDO enum mirrors.
 *
 * AzDO's REST/SDK exposes a few small enums (`PullRequestStatus`,
 * `IdentityRefWithVote.vote`) as bare numbers. We mirror them here as
 * named constants so the call sites read intent-first instead of
 * reaching for the magic literal — and so the values live in one
 * place if AzDO ever adds a new state.
 */

/**
 * Default fields requested via `/wit/workitems` batches. Matches the
 * canonical-item shape the rest of the app expects; expanding this
 * list expands the row footprint in Postgres, so add fields with
 * intent.
 */
export const DEFAULT_WORKITEM_FIELDS = [
  "System.Id",
  "System.WorkItemType",
  "System.Title",
  "System.Description",
  "System.State",
  "System.AssignedTo",
  "System.Parent",
  "System.Tags",
  "System.ChangedDate",
  "System.CreatedDate",
  "System.CommentCount",
  "System.AreaPath",
  "System.IterationPath",
  "System.TeamProject",
  "System.NodeName",
  "Microsoft.VSTS.Common.ClosedDate",
] as const;

/**
 * AzDO caps `/wit/workitemsbatch` at 200 ids per call. Hardcoded by
 * the service, not a tunable — keeping the constant named so the
 * call site documents the cap.
 */
export const MAX_BATCH_IDS = 200;

/**
 * AzDO `PullRequestStatus` enum values. SDK exposes these as bare
 * numbers; mirroring as a named const keeps call sites readable.
 *  - 0 = NotSet, 4 = All (not real PR states; ignored here)
 */
export const AZDO_PR_STATUS = {
  Active: 1,
  Abandoned: 2,
  Completed: 3,
} as const;

/**
 * AzDO `IdentityRefWithVote.vote` enum values. The reviewer vote is
 * the only field outside `PullRequestStatus` we read as a magic
 * number anywhere; named constants make the mapping in
 * `voteToReviewState` self-documenting.
 */
export const AZDO_REVIEWER_VOTE = {
  Approved: 10,
  ApprovedWithSuggestions: 5,
  NoResponse: 0,
  WaitingForAuthor: -5,
  Rejected: -10,
} as const;
