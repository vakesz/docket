/**
 * Behavioural test for `GitHubProvider.searchPullRequests`.
 *
 * The keyword-search fallback the agent reaches for when
 * `findRelatedPRs` returns no link-driven matches. Asserts the query
 * shape (state filter, repo scope), the result mapping (PRs only,
 * confidence floor, state derivation), and the per_page clamping.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  searchIssuesAndPullRequests: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    search = {
      issuesAndPullRequests: handlers.searchIssuesAndPullRequests,
    };
  },
}));

const { GitHubProvider } = await import("@/providers/github/provider");

function makeProvider(): InstanceType<typeof GitHubProvider> {
  return new GitHubProvider({ owner: "o", repo: "r", accessToken: "t" });
}

beforeEach(() => {
  handlers.searchIssuesAndPullRequests.mockReset();
});

describe("searchPullRequests", () => {
  it("scopes the query to the configured repo and applies a state filter", async () => {
    handlers.searchIssuesAndPullRequests.mockResolvedValueOnce({ data: { items: [] } });
    await makeProvider().searchPullRequests("oauth modal skip", { state: "merged", limit: 20 });
    const call = handlers.searchIssuesAndPullRequests.mock.calls[0]?.[0] as {
      q: string;
      per_page: number;
    };
    expect(call.q).toBe("repo:o/r type:pr is:merged oauth modal skip");
    expect(call.per_page).toBe(20);
  });

  it("omits the state qualifier when state=all", async () => {
    handlers.searchIssuesAndPullRequests.mockResolvedValueOnce({ data: { items: [] } });
    await makeProvider().searchPullRequests("foo", { state: "all", limit: 5 });
    const call = handlers.searchIssuesAndPullRequests.mock.calls[0]?.[0] as { q: string };
    expect(call.q).toBe("repo:o/r type:pr foo");
  });

  it("clamps per_page to the API max of 50", async () => {
    handlers.searchIssuesAndPullRequests.mockResolvedValueOnce({ data: { items: [] } });
    await makeProvider().searchPullRequests("foo", { state: "all", limit: 999 });
    const call = handlers.searchIssuesAndPullRequests.mock.calls[0]?.[0] as { per_page: number };
    expect(call.per_page).toBe(50);
  });

  it("filters out non-PR items and returns matches at the keyword-search confidence floor", async () => {
    handlers.searchIssuesAndPullRequests.mockResolvedValueOnce({
      data: {
        items: [
          {
            title: "Skip the OAuth provider modal when only one is configured",
            html_url: "https://github.com/o/r/pull/77",
            state: "closed",
            user: { login: "alice" },
            pull_request: {
              html_url: "https://github.com/o/r/pull/77",
              merged_at: "2025-02-01T00:00:00Z",
            },
          },
          {
            // an issue, not a PR — must be filtered out
            title: "Track OAuth UX feedback",
            html_url: "https://github.com/o/r/issues/501",
            state: "open",
            user: { login: "bob" },
            pull_request: null,
          },
        ],
      },
    });

    const matches = await makeProvider().searchPullRequests("oauth modal", {
      state: "all",
      limit: 20,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      url: "https://github.com/o/r/pull/77",
      state: "merged",
      author: "alice",
      confidence: 0.2,
    });
  });

  it("wraps octokit auth failures as ProviderAuthError", async () => {
    const err = Object.assign(new Error("bad creds"), { status: 401 });
    handlers.searchIssuesAndPullRequests.mockRejectedValueOnce(err);
    await expect(
      makeProvider().searchPullRequests("foo", { state: "all", limit: 20 }),
    ).rejects.toMatchObject({ name: "ProviderAuthError" });
  });
});
