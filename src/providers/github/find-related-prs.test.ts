/**
 * Behavioural test for `GitHubProvider.findRelatedPRs`.
 *
 * Mocks `@octokit/rest` so we can drive the three signals (timeline,
 * search, branch list) independently and assert on merge/scoring/error
 * policy without hitting the network.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  listEventsForTimeline: vi.fn(),
  searchIssuesAndPullRequests: vi.fn(),
  pullsList: vi.fn(),
  paginate: vi.fn(),
}));

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    issues = {
      listEventsForTimeline: handlers.listEventsForTimeline,
    };
    search = {
      issuesAndPullRequests: handlers.searchIssuesAndPullRequests,
    };
    pulls = {
      list: handlers.pullsList,
    };
    paginate = handlers.paginate;
  },
}));

const { GitHubProvider } = await import("@/providers/github/provider");

function makeProvider(): InstanceType<typeof GitHubProvider> {
  return new GitHubProvider({ owner: "o", repo: "r", accessToken: "t" });
}

beforeEach(() => {
  handlers.listEventsForTimeline.mockReset();
  handlers.searchIssuesAndPullRequests.mockReset();
  handlers.pullsList.mockReset();
  handlers.paginate.mockReset();
});

describe("findRelatedPRs", () => {
  it("scores a closing-keyword timeline reference at 0.95", async () => {
    handlers.paginate.mockResolvedValueOnce([
      {
        event: "cross-referenced",
        source: {
          issue: {
            title: "Skip oauth modal",
            body: "Fixes #4538 by short-circuiting when only one provider is configured.",
            state: "closed",
            html_url: "https://github.com/o/r/pull/99",
            user: { login: "alice" },
            pull_request: {
              html_url: "https://github.com/o/r/pull/99",
              merged_at: "2025-01-01T00:00:00Z",
            },
          },
        },
      },
    ]);
    handlers.searchIssuesAndPullRequests.mockResolvedValueOnce({ data: { items: [] } });
    handlers.pullsList.mockResolvedValueOnce({ data: [] });

    const matches = await makeProvider().findRelatedPRs("o/r#4538");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      url: "https://github.com/o/r/pull/99",
      confidence: 0.95,
      state: "merged",
      author: "alice",
    });
  });

  it("dedupes a PR seen via both timeline and search, keeping the higher confidence", async () => {
    handlers.paginate.mockResolvedValueOnce([
      {
        event: "cross-referenced",
        source: {
          issue: {
            title: "Skip oauth modal",
            body: "Fixes #4538",
            state: "open",
            html_url: "https://github.com/o/r/pull/99",
            user: { login: "alice" },
            pull_request: {
              html_url: "https://github.com/o/r/pull/99",
              merged_at: null,
            },
          },
        },
      },
    ]);
    handlers.searchIssuesAndPullRequests.mockResolvedValueOnce({
      data: {
        items: [
          {
            title: "Skip oauth modal",
            html_url: "https://github.com/o/r/pull/99",
            state: "open",
            user: { login: "alice" },
            pull_request: {
              html_url: "https://github.com/o/r/pull/99",
              merged_at: null,
            },
          },
        ],
      },
    });
    handlers.pullsList.mockResolvedValueOnce({ data: [] });

    const matches = await makeProvider().findRelatedPRs("o/r#4538");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe(0.95);
  });

  it("includes branch-name-only matches at 0.3", async () => {
    handlers.paginate.mockResolvedValueOnce([]);
    handlers.searchIssuesAndPullRequests.mockResolvedValueOnce({ data: { items: [] } });
    handlers.pullsList.mockResolvedValueOnce({
      data: [
        {
          title: "WIP",
          html_url: "https://github.com/o/r/pull/123",
          state: "open",
          merged_at: null,
          user: { login: "bob" },
          head: { ref: "fix/4538-rebase" },
        },
        {
          title: "unrelated",
          html_url: "https://github.com/o/r/pull/124",
          state: "open",
          merged_at: null,
          user: { login: "carol" },
          head: { ref: "feature/login" },
        },
      ],
    });

    const matches = await makeProvider().findRelatedPRs("o/r#4538");
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      url: "https://github.com/o/r/pull/123",
      branch: "fix/4538-rebase",
      confidence: 0.3,
    });
  });

  it("returns the survivors when one signal fails", async () => {
    handlers.paginate.mockRejectedValueOnce(new Error("timeline 502"));
    handlers.searchIssuesAndPullRequests.mockResolvedValueOnce({
      data: {
        items: [
          {
            title: "Skip oauth modal (#4538)",
            html_url: "https://github.com/o/r/pull/99",
            state: "open",
            user: { login: "alice" },
            pull_request: {
              html_url: "https://github.com/o/r/pull/99",
              merged_at: null,
            },
          },
        ],
      },
    });
    handlers.pullsList.mockResolvedValueOnce({ data: [] });

    const matches = await makeProvider().findRelatedPRs("o/r#4538");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.confidence).toBe(0.6);
  });

  it("throws when every signal fails", async () => {
    const err = Object.assign(new Error("nope"), { status: 500 });
    handlers.paginate.mockRejectedValueOnce(err);
    handlers.searchIssuesAndPullRequests.mockRejectedValueOnce(err);
    handlers.pullsList.mockRejectedValueOnce(err);

    await expect(makeProvider().findRelatedPRs("o/r#4538")).rejects.toThrow();
  });
});
