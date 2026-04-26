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

import type { LabelTemplate, ProviderSpec } from "@/core/provider";
import { GitHubProvider } from "@/providers/github/provider";

const labelTemplate: LabelTemplate = (config) => {
  const owner = typeof config.owner === "string" ? config.owner.trim() : "";
  const repo = typeof config.repo === "string" ? config.repo.trim() : "";
  if (!owner || !repo) {
    return "";
  }
  return `${owner}/${repo}`;
};

export const githubSpec: ProviderSpec = {
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
  supportedKinds: ["task", "bug"],
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
};
