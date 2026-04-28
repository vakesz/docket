/**
 * Pure helpers for `findRelatedPRs` on the GitHub provider.
 *
 * Kept separate from `provider.ts` so the matching/scoring/merging logic is
 * unit-testable without mocking Octokit. The provider handles the network
 * round-trips; this module decides what counts as a match and how confident
 * to be about it.
 */

import type { PRMatch } from "@/core/types";

export const CONFIDENCE_TIMELINE_CLOSING = 0.95;
export const CONFIDENCE_TIMELINE_CONNECTED = 0.9;
export const CONFIDENCE_TIMELINE_MENTION = 0.7;
export const CONFIDENCE_SEARCH_TITLE = 0.6;
export const CONFIDENCE_SEARCH_BODY = 0.4;
export const CONFIDENCE_BRANCH_NAME = 0.3;

export const MAX_MATCHES = 10;

const CLOSING_KEYWORD_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:#|gh-)?(\d+)/gi;

/**
 * True when `body` contains a GitHub closing keyword targeting `issueNumber`.
 *
 * Recognizes the canonical forms ("Fixes #4538", "closes GH-4538",
 * "resolved 4538") that GitHub itself recognizes for auto-closing on merge.
 * Cross-repo references (`Fixes owner/repo#4538`) are intentionally not
 * matched here — the agent already scopes to the configured repo.
 */
export function bodyHasClosingKeyword(body: string, issueNumber: number): boolean {
  CLOSING_KEYWORD_RE.lastIndex = 0;
  for (;;) {
    const match = CLOSING_KEYWORD_RE.exec(body);
    if (!match) return false;
    if (Number.parseInt(match[1] ?? "", 10) === issueNumber) return true;
  }
}

/**
 * True when a PR's `head.ref` looks like it was named after `issueNumber`.
 *
 * Matches the common conventions (`issue-4538`, `fix/4538`, `4538-foo`,
 * `gh-4538`) without lighting up on coincidental substrings — the number
 * must be bounded by non-digits so `#45` doesn't bait on branch `pr-453`.
 */
export function branchMatchesIssue(branch: string, issueNumber: number): boolean {
  const re = new RegExp(`(?:^|[^0-9])${issueNumber}(?:[^0-9]|$)`);
  return re.test(branch);
}

/**
 * Title contains a `#<n>` or `GH-<n>` reference to the issue.
 *
 * Used to upgrade search hits from "body mention" to "title mention" — a
 * stronger signal because PR authors rarely repeat unrelated issue numbers
 * in their title.
 */
export function titleMentionsIssue(title: string, issueNumber: number): boolean {
  const re = new RegExp(`(?:^|[^0-9])(?:#|gh-)${issueNumber}(?:[^0-9]|$)`, "i");
  return re.test(title);
}

/**
 * Dedupe matches by url, keeping the highest-confidence record per PR, then
 * sort by confidence desc with `merged > open > closed` as a tiebreaker, and
 * cap at `MAX_MATCHES` so the agent's tool result stays compact.
 */
export function mergeMatches(matches: readonly PRMatch[]): PRMatch[] {
  const byUrl = new Map<string, PRMatch>();
  for (const m of matches) {
    const existing = byUrl.get(m.url);
    if (!existing || m.confidence > existing.confidence) {
      byUrl.set(m.url, m);
    }
  }
  const stateRank: Record<string, number> = { merged: 3, open: 2, closed: 1 };
  return [...byUrl.values()]
    .sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      const ra = stateRank[a.state] ?? 0;
      const rb = stateRank[b.state] ?? 0;
      return rb - ra;
    })
    .slice(0, MAX_MATCHES);
}
