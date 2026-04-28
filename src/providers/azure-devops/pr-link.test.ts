import { describe, expect, it } from "vitest";
import {
  changeTypeToStatus,
  parseAzdoPullRequestId,
  parseVstfsPRRef,
  pullRequestStatusToCanonical,
  stripRefPrefix,
  voteToReviewState,
} from "@/providers/azure-devops/pr-link";

describe("parseVstfsPRRef", () => {
  it("parses a canonical artifact url", () => {
    const url = "vstfs:///Git/PullRequestId/proj-guid%2Frepo-guid%2F42";
    expect(parseVstfsPRRef(url)).toEqual({
      projectId: "proj-guid",
      repoId: "repo-guid",
      pullRequestId: 42,
    });
  });

  it("decodes percent-encoded segments", () => {
    const url = "vstfs:///Git/PullRequestId/My%20Project%2FRepo%20Name%2F7";
    expect(parseVstfsPRRef(url)).toEqual({
      projectId: "My Project",
      repoId: "Repo Name",
      pullRequestId: 7,
    });
  });

  it.each([
    "",
    "https://example.com/foo",
    "vstfs:///Git/CommitId/proj%2Frepo%2Fabc123",
    "vstfs:///Git/PullRequestId/onlyone%2F",
    "vstfs:///Git/PullRequestId/proj%2Frepo%2Fnotanumber",
  ])("returns null for malformed input %s", (url) => {
    expect(parseVstfsPRRef(url)).toBeNull();
  });
});

describe("parseAzdoPullRequestId", () => {
  it("accepts a plain numeric string", () => {
    expect(parseAzdoPullRequestId("42")).toBe(42);
  });

  it("extracts from a web url", () => {
    expect(
      parseAzdoPullRequestId("https://dev.azure.com/contoso/Platform/_git/web/pullrequest/123"),
    ).toBe(123);
  });

  it("extracts from a vstfs url", () => {
    expect(parseAzdoPullRequestId("vstfs:///Git/PullRequestId/proj%2Frepo%2F88")).toBe(88);
  });

  it("returns null for unparseable input", () => {
    expect(parseAzdoPullRequestId("not a pr")).toBeNull();
  });
});

describe("pullRequestStatusToCanonical", () => {
  it("maps the AzDO PullRequestStatus enum", () => {
    expect(pullRequestStatusToCanonical(1)).toBe("open");
    expect(pullRequestStatusToCanonical(2)).toBe("closed");
    expect(pullRequestStatusToCanonical(3)).toBe("merged");
    expect(pullRequestStatusToCanonical(0)).toBe("open");
    expect(pullRequestStatusToCanonical(undefined)).toBe("open");
    expect(pullRequestStatusToCanonical(null)).toBe("open");
  });
});

describe("voteToReviewState", () => {
  it.each([
    [10, "APPROVED"],
    [5, "APPROVED"],
    [0, "COMMENTED"],
    [-5, "CHANGES_REQUESTED"],
    [-10, "CHANGES_REQUESTED"],
    [undefined, "COMMENTED"],
    [null, "COMMENTED"],
  ])("vote %s -> %s", (vote, expected) => {
    expect(voteToReviewState(vote)).toBe(expected);
  });
});

describe("stripRefPrefix", () => {
  it("strips refs/heads/", () => {
    expect(stripRefPrefix("refs/heads/main")).toBe("main");
    expect(stripRefPrefix("refs/heads/feature/foo")).toBe("feature/foo");
  });

  it("passes through non-refs values", () => {
    expect(stripRefPrefix("main")).toBe("main");
    expect(stripRefPrefix("")).toBe("");
    expect(stripRefPrefix(undefined)).toBe("");
    expect(stripRefPrefix(null)).toBe("");
  });
});

describe("changeTypeToStatus", () => {
  it("maps VersionControlChangeType flags", () => {
    expect(changeTypeToStatus(1)).toBe("added");
    expect(changeTypeToStatus(2)).toBe("modified");
    expect(changeTypeToStatus(4)).toBe("renamed");
    expect(changeTypeToStatus(8)).toBe("removed");
    expect(changeTypeToStatus(0)).toBe("modified");
    expect(changeTypeToStatus(undefined)).toBe("modified");
    expect(changeTypeToStatus(null)).toBe("modified");
  });

  it("treats rename+edit as renamed (rename flag wins)", () => {
    expect(changeTypeToStatus(4 | 2)).toBe("renamed");
  });
});
