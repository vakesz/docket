/**
 * Static metadata for the GitHub provider type — declares scope axes,
 * setup fields, label template, and the factory that constructs a live
 * `WorkItemProvider` from a config object.
 *
 * Configs reaching the factory have shape:
 *   { owner: string, repo: string, accessToken: string, baseUrl?: string }
 *
 * `owner` / `repo` come from the project's `providerScope` JSON column.
 * `accessToken` is injected by the server-side provider builder (it reads
 * the user's `Account.access_token` for `provider="github"` and merges it
 * into the config). `baseUrl` defaults to https://api.github.com.
 */

import type { LabelTemplate, ProviderItemNumberCodec, ProviderSpec } from "@/core/provider";
import { githubAvatarFetcher } from "@/providers/github/avatar";
import { githubProfileUrl } from "@/providers/github/profile";
import { GitHubProvider } from "@/providers/github/provider";
import { GITHUB_REACTION_KINDS } from "@/providers/github/reactions";

/**
 * GitHub providerItemId is `${owner}/${repo}#${number}`. The `(owner, repo)`
 * tuple is constant within a project (it's the providerScope), so the URL
 * only carries the issue/PR number.
 */
const itemNumberCodec: ProviderItemNumberCodec = {
  parseItemNumber: (scope, urlNumber) => {
    if (!/^\d+$/.test(urlNumber)) return null;
    const owner = typeof scope.owner === "string" ? scope.owner.trim() : "";
    const repo = typeof scope.repo === "string" ? scope.repo.trim() : "";
    if (!owner || !repo) return null;
    return `${owner}/${repo}#${urlNumber}`;
  },
  formatItemNumber: (providerItemId) => {
    const hash = providerItemId.lastIndexOf("#");
    return hash === -1 ? providerItemId : providerItemId.slice(hash + 1);
  },
};

const labelTemplate: LabelTemplate = (config) => {
  const owner = typeof config.owner === "string" ? config.owner.trim() : "";
  const repo = typeof config.repo === "string" ? config.repo.trim() : "";
  if (!owner || !repo) {
    return "";
  }
  return `${owner}/${repo}`;
};

export const githubSpec = {
  typeId: "github",
  displayName: "GitHub",
  factory: (config) => new GitHubProvider(config),
  setupFields: [
    {
      key: "owner",
      label: "Owner",
      kind: "string",
      required: true,
      placeholder: "acme",
      help: "GitHub user or organization that owns the repository.",
    },
    {
      key: "repo",
      label: "Repository",
      kind: "string",
      required: true,
      placeholder: "web",
      help: "Repository name (without the owner prefix).",
    },
  ],
  requiresCli: [],
  grouping: "by_state_bucket",
  normalizeConfig: (raw) => {
    const owner = typeof raw.owner === "string" ? raw.owner.trim() : "";
    const repo = typeof raw.repo === "string" ? raw.repo.trim() : "";
    if (!owner) {
      throw new Error("GitHub: 'owner' is required");
    }
    if (!repo) {
      throw new Error("GitHub: 'repo' is required");
    }
    return { owner, repo };
  },
  labelTemplate,
  scopeAxes: [],
  axisMatcher: null,
  axisExtract: null,
  itemNumberCodec,
  capabilities: {
    supportedReactions: GITHUB_REACTION_KINDS,
    ciStatus: true,
    pullRequestDiffs: true,
    linkedItems: true,
  },
  oauth: {
    defaultLabel: "GitHub",
    defaultScopes: "read:user user:email repo",
    baseUrlPlaceholder: "GitHub Enterprise base URL (leave blank for github.com)",
    baseUrlHelpKey: "github_enterprise",
  },
  profileUrl: githubProfileUrl,
  avatarFetcher: githubAvatarFetcher,
} satisfies ProviderSpec;
