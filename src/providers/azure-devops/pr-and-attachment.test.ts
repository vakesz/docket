/**
 * Behavioural tests for the AzDO provider's PR-link surface and attachment
 * upload. Mocks `azure-devops-node-api` so we can drive the SDK shape from
 * the test without hitting the network.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const witHandlers = vi.hoisted(() => ({
  createAttachment: vi.fn(),
  updateWorkItem: vi.fn(),
  getWorkItem: vi.fn(),
}));

const gitHandlers = vi.hoisted(() => ({
  getPullRequestById: vi.fn(),
  getPullRequestIterations: vi.fn(),
  getPullRequestIterationChanges: vi.fn(),
}));

vi.mock("azure-devops-node-api", () => ({
  getBearerHandler: vi.fn(() => ({})),
  WebApi: class {
    getWorkItemTrackingApi = vi.fn(async () => witHandlers);
    getGitApi = vi.fn(async () => gitHandlers);
  },
}));

const { AzureDevOpsProvider } = await import("@/providers/azure-devops/provider");

function makeProvider() {
  return new AzureDevOpsProvider({
    orgUrl: "https://dev.azure.com/contoso",
    project: "Platform",
    accessToken: "tok",
  });
}

beforeEach(() => {
  for (const h of Object.values(witHandlers)) h.mockReset();
  for (const h of Object.values(gitHandlers)) h.mockReset();
});

describe("uploadAttachment", () => {
  it("uploads bytes then attaches the relation, returning the blob url", async () => {
    witHandlers.createAttachment.mockResolvedValueOnce({
      id: "blob-id",
      url: "https://dev.azure.com/contoso/_apis/wit/attachments/blob-id",
    });
    witHandlers.updateWorkItem.mockResolvedValueOnce({});

    const url = await makeProvider().uploadAttachment(
      "42",
      "diagram.png",
      new Uint8Array([1, 2, 3]),
      "image/png",
    );

    expect(url).toBe("https://dev.azure.com/contoso/_apis/wit/attachments/blob-id");
    expect(witHandlers.createAttachment).toHaveBeenCalledTimes(1);
    expect(witHandlers.updateWorkItem).toHaveBeenCalledTimes(1);
    const [, patch, workItemId] = witHandlers.updateWorkItem.mock.calls[0] ?? [];
    expect(workItemId).toBe(42);
    expect(patch).toEqual([
      {
        op: 0,
        path: "/relations/-",
        value: {
          rel: "AttachedFile",
          url: "https://dev.azure.com/contoso/_apis/wit/attachments/blob-id",
          attributes: { name: "diagram.png", comment: "" },
        },
      },
    ]);
  });

  it("does not call updateWorkItem if createAttachment fails", async () => {
    witHandlers.createAttachment.mockRejectedValueOnce(new Error("blob 500"));

    await expect(
      makeProvider().uploadAttachment("42", "x.png", new Uint8Array([1]), "image/png"),
    ).rejects.toThrow();
    expect(witHandlers.updateWorkItem).not.toHaveBeenCalled();
  });

  it("does not retry or clean up if the relation patch fails", async () => {
    witHandlers.createAttachment.mockResolvedValueOnce({
      id: "blob-id",
      url: "https://dev.azure.com/contoso/_apis/wit/attachments/blob-id",
    });
    witHandlers.updateWorkItem.mockRejectedValueOnce(new Error("relation 500"));

    await expect(
      makeProvider().uploadAttachment("42", "x.png", new Uint8Array([1]), "image/png"),
    ).rejects.toThrow();
    expect(witHandlers.createAttachment).toHaveBeenCalledTimes(1);
    expect(witHandlers.updateWorkItem).toHaveBeenCalledTimes(1);
  });
});

describe("findRelatedPRs", () => {
  it("returns matches for ArtifactLink relations pointing at PRs", async () => {
    witHandlers.getWorkItem.mockResolvedValueOnce({
      id: 42,
      relations: [
        {
          rel: "ArtifactLink",
          url: "vstfs:///Git/PullRequestId/proj-guid%2Frepo-guid%2F123",
          attributes: { name: "Pull Request" },
        },
        {
          rel: "ArtifactLink",
          url: "vstfs:///Git/Branch/proj-guid%2Frepo-guid%2Ffeature%2Fbar",
          attributes: { name: "Branch" },
        },
        {
          rel: "ArtifactLink",
          url: "vstfs:///Git/Commit/proj-guid%2Frepo-guid%2Fabc123",
          attributes: { name: "Fixed in Commit" },
        },
        {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: "https://dev.azure.com/contoso/_apis/wit/workItems/41",
        },
      ],
    });
    gitHandlers.getPullRequestById.mockResolvedValueOnce({
      pullRequestId: 123,
      title: "Skip oauth modal",
      sourceRefName: "refs/heads/fix/4538",
      status: 3,
      createdBy: { uniqueName: "alice@example.com", displayName: "Alice" },
      repository: { name: "web" },
    });

    const matches = await makeProvider().findRelatedPRs("42");

    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      url: "https://dev.azure.com/contoso/Platform/_git/web/pullrequest/123",
      title: "Skip oauth modal",
      branch: "fix/4538",
      state: "merged",
      author: "alice@example.com",
      confidence: 0.95,
    });
  });

  it("returns the survivors when one PR fetch fails", async () => {
    witHandlers.getWorkItem.mockResolvedValueOnce({
      relations: [
        {
          rel: "ArtifactLink",
          url: "vstfs:///Git/PullRequestId/p%2Fr%2F1",
          attributes: { name: "Pull Request" },
        },
        {
          rel: "ArtifactLink",
          url: "vstfs:///Git/PullRequestId/p%2Fr%2F2",
          attributes: { name: "Pull Request" },
        },
      ],
    });
    gitHandlers.getPullRequestById.mockRejectedValueOnce(new Error("404")).mockResolvedValueOnce({
      pullRequestId: 2,
      title: "Other PR",
      sourceRefName: "refs/heads/topic",
      status: 1,
      createdBy: { uniqueName: "bob@example.com" },
      repository: { name: "web" },
    });

    const matches = await makeProvider().findRelatedPRs("42");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.url).toContain("/pullrequest/2");
    expect(matches[0]?.state).toBe("open");
  });

  it("returns an empty array when no PR-shaped relations are present", async () => {
    witHandlers.getWorkItem.mockResolvedValueOnce({
      relations: [{ rel: "System.LinkTypes.Related", url: "https://example.com/wi/1" }],
    });

    const matches = await makeProvider().findRelatedPRs("42");
    expect(matches).toEqual([]);
    expect(gitHandlers.getPullRequestById).not.toHaveBeenCalled();
  });

  it("throws on invalid work item id without making API calls", async () => {
    await expect(makeProvider().findRelatedPRs("not-a-number")).rejects.toThrow();
    expect(witHandlers.getWorkItem).not.toHaveBeenCalled();
  });
});

describe("getPullRequest", () => {
  it("hydrates metadata + file list from iterations", async () => {
    gitHandlers.getPullRequestById.mockResolvedValueOnce({
      pullRequestId: 123,
      title: "Skip oauth modal",
      description: "Body",
      status: 3,
      isDraft: false,
      createdBy: { uniqueName: "alice@example.com" },
      sourceRefName: "refs/heads/fix/4538",
      targetRefName: "refs/heads/main",
      lastMergeSourceCommit: { commitId: "abc123" },
      labels: [{ name: "bug" }, { name: "" }],
      reviewers: [
        { uniqueName: "bob@example.com", vote: 10 },
        { uniqueName: "carol@example.com", vote: -10 },
      ],
      repository: { id: "repo-guid", name: "web" },
      creationDate: new Date("2025-01-01T00:00:00Z"),
      closedDate: new Date("2025-01-02T00:00:00Z"),
    });
    gitHandlers.getPullRequestIterations.mockResolvedValueOnce([{ id: 1 }, { id: 2 }]);
    gitHandlers.getPullRequestIterationChanges.mockResolvedValueOnce({
      changeEntries: [
        { item: { path: "/src/login.ts" }, changeType: 2 },
        { item: { path: "/src/old.ts" }, changeType: 8 },
        { item: { path: "/src/new.ts" }, changeType: 1 },
      ],
    });

    const pr = await makeProvider().getPullRequest("123");

    expect(gitHandlers.getPullRequestIterations).toHaveBeenCalledWith("repo-guid", 123, "Platform");
    expect(gitHandlers.getPullRequestIterationChanges).toHaveBeenCalledWith(
      "repo-guid",
      123,
      2,
      "Platform",
    );
    expect(pr.state).toBe("merged");
    expect(pr.merged).toBe(true);
    expect(pr.headRef).toBe("fix/4538");
    expect(pr.baseRef).toBe("main");
    expect(pr.headSha).toBe("abc123");
    expect(pr.labels).toEqual(["bug"]);
    expect(pr.reviews.map((r) => r.state)).toEqual(["APPROVED", "CHANGES_REQUESTED"]);
    expect(pr.files.map((f) => [f.path, f.status])).toEqual([
      ["/src/login.ts", "modified"],
      ["/src/old.ts", "removed"],
      ["/src/new.ts", "added"],
    ]);
    expect(pr.changedFiles).toBe(3);
    expect(pr.url).toBe("https://dev.azure.com/contoso/Platform/_git/web/pullrequest/123");
    expect(pr.updatedAt).toEqual(new Date("2025-01-02T00:00:00Z"));
  });

  it("survives iteration-changes failure with metadata-only response", async () => {
    gitHandlers.getPullRequestById.mockResolvedValueOnce({
      pullRequestId: 5,
      title: "WIP",
      status: 1,
      createdBy: { uniqueName: "x" },
      sourceRefName: "refs/heads/wip",
      targetRefName: "refs/heads/main",
      repository: { id: "repo-guid", name: "web" },
    });
    gitHandlers.getPullRequestIterations.mockRejectedValueOnce(new Error("403"));

    const pr = await makeProvider().getPullRequest("5");
    expect(pr.files).toEqual([]);
    expect(pr.changedFiles).toBe(0);
    expect(pr.state).toBe("open");
  });

  it("accepts a web url as prId", async () => {
    gitHandlers.getPullRequestById.mockResolvedValueOnce({
      pullRequestId: 99,
      title: "T",
      status: 1,
      createdBy: { uniqueName: "x" },
      sourceRefName: "refs/heads/foo",
      targetRefName: "refs/heads/main",
      repository: { id: "r", name: "web" },
    });
    gitHandlers.getPullRequestIterations.mockResolvedValueOnce([]);

    const pr = await makeProvider().getPullRequest(
      "https://dev.azure.com/contoso/Platform/_git/web/pullrequest/99",
    );
    expect(pr.number).toBe(99);
    expect(gitHandlers.getPullRequestById).toHaveBeenCalledWith(99, "Platform");
  });

  it("rejects an unparseable prId without calling the SDK", async () => {
    await expect(makeProvider().getPullRequest("nope")).rejects.toThrow();
    expect(gitHandlers.getPullRequestById).not.toHaveBeenCalled();
  });
});
