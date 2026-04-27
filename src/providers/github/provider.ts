/**
 * GitHub `WorkItemProvider` implementation backed by `@octokit/rest`.
 *
 * Constructed from a config object with shape `{ owner, repo, accessToken }`
 * — the access token comes from the calling user's NextAuth `Account` row
 * for `provider="github"`. The class never reaches into env vars or
 * persistent stores; everything it needs to talk to GitHub is in `config`.
 */

import { Octokit } from "@octokit/rest";
import type { WorkItemProvider } from "@/core/provider";
import { ProviderAuthError, ProviderError, ProviderUnreachableError } from "@/core/provider";
import type {
  CIStatus,
  Comment,
  CommitDetail,
  CreateFields,
  Item,
  ItemKind,
  PRMatch,
  PullRequestDetail,
  TransitionIntent,
} from "@/core/types";
import {
  type GithubIssueState,
  type GithubStateReason,
  mergeLabels,
  planForIntent,
  STATE_ENCODING_LABELS,
  toCanonicalState,
} from "@/providers/github/state-map";

type Config = {
  owner: string;
  repo: string;
  accessToken: string;
  baseUrl?: string;
};

function readConfig(raw: Record<string, unknown>): Config {
  const owner = typeof raw.owner === "string" ? raw.owner : "";
  const repo = typeof raw.repo === "string" ? raw.repo : "";
  const accessToken = typeof raw.accessToken === "string" ? raw.accessToken : "";
  const baseUrl = typeof raw.baseUrl === "string" && raw.baseUrl ? raw.baseUrl : undefined;
  if (!owner || !repo) {
    throw new ProviderError("GitHub provider config is missing 'owner' or 'repo'");
  }
  if (!accessToken) {
    throw new ProviderAuthError(
      "GitHub provider config is missing 'accessToken'; sign in with GitHub first.",
    );
  }
  return { owner, repo, accessToken, baseUrl };
}

function makeProviderItemId(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`;
}

function parseProviderItemId(id: string): { owner: string; repo: string; number: number } {
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(id);
  if (!match) {
    throw new ProviderError(`Invalid GitHub providerItemId: ${id}`);
  }
  const owner = match[1];
  const repo = match[2];
  const numberStr = match[3];
  if (!owner || !repo || !numberStr) {
    throw new ProviderError(`Invalid GitHub providerItemId: ${id}`);
  }
  return { owner, repo, number: Number.parseInt(numberStr, 10) };
}

function inferKind(labels: readonly string[]): ItemKind {
  for (const label of labels) {
    const lc = label.toLowerCase();
    if (lc === "bug") return "bug";
    if (lc === "epic") return "epic";
    if (lc === "feature" || lc === "enhancement") return "feature";
    if (lc === "story" || lc === "user-story") return "story";
  }
  return "task";
}

type IssueLikePayload = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  state_reason?: string | null;
  user?: { login?: string | null } | null;
  assignee?: { login?: string | null } | null;
  labels: ReadonlyArray<string | { name?: string | null }>;
  html_url: string;
  repository_url?: string | null;
  created_at: string;
  updated_at: string;
  pull_request?: unknown;
};

function labelsOf(issue: IssueLikePayload): string[] {
  return issue.labels
    .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
    .filter((name): name is string => Boolean(name));
}

function wrapOctokitError(err: unknown): never {
  const status = (err as { status?: number } | null)?.status;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 401 || status === 403) {
    throw new ProviderAuthError(`GitHub auth rejected: ${message}`);
  }
  if (status && status >= 500) {
    throw new ProviderUnreachableError(`GitHub upstream error: ${message}`);
  }
  if (err instanceof Error && /fetch failed|ENOTFOUND|ECONNREFUSED/i.test(err.message)) {
    throw new ProviderUnreachableError(`GitHub unreachable: ${message}`);
  }
  throw new ProviderError(message);
}

export class GitHubProvider implements WorkItemProvider {
  private readonly config: Config;
  private readonly octokit: Octokit;
  private readonly providerKey: string;

  constructor(rawConfig: Record<string, unknown>) {
    this.config = readConfig(rawConfig);
    this.providerKey = `github:${this.config.owner}/${this.config.repo}`;
    this.octokit = new Octokit({
      auth: this.config.accessToken,
      ...(this.config.baseUrl ? { baseUrl: this.config.baseUrl } : {}),
    });
  }

  private toCanonicalItem(issue: IssueLikePayload): Item {
    if (issue.pull_request) {
      // PRs come back through the same /issues endpoint; skip them — sync only
      // wants real issues.
      throw new ProviderError("Refusing to translate a PR as an issue");
    }
    const labels = labelsOf(issue);
    return {
      id: makeProviderItemId(this.config.owner, this.config.repo, issue.number),
      kind: inferKind(labels),
      title: issue.title,
      descriptionMd: issue.body ?? "",
      state: toCanonicalState(
        {
          state: issue.state as GithubIssueState,
          stateReason: (issue.state_reason ?? null) as GithubStateReason,
        },
        labels,
      ),
      assignee: issue.assignee?.login ?? null,
      author: issue.user?.login ?? null,
      parentId: null,
      tags: labels,
      createdAt: new Date(issue.created_at),
      updatedAt: new Date(issue.updated_at),
      url: issue.html_url,
      repositoryUrl: `https://github.com/${this.config.owner}/${this.config.repo}`,
      attachments: [],
      providerRaw: issue as unknown as Record<string, unknown>,
      providerKey: this.providerKey,
    };
  }

  async healthCheck(): Promise<void> {
    try {
      await this.octokit.repos.get({ owner: this.config.owner, repo: this.config.repo });
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async *listChangesSince(watermark: Date | null): AsyncIterable<Item> {
    const params: Parameters<typeof this.octokit.issues.listForRepo>[0] = {
      owner: this.config.owner,
      repo: this.config.repo,
      state: "all",
      per_page: 100,
      sort: "updated",
      direction: "desc",
    };
    if (watermark) {
      params.since = watermark.toISOString();
    }
    try {
      for await (const page of this.octokit.paginate.iterator(
        this.octokit.issues.listForRepo,
        params,
      )) {
        for (const issue of page.data as IssueLikePayload[]) {
          if (issue.pull_request) continue;
          yield this.toCanonicalItem(issue);
        }
      }
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async getItem(id: string): Promise<Item> {
    const { owner, repo, number } = parseProviderItemId(id);
    try {
      const res = await this.octokit.issues.get({ owner, repo, issue_number: number });
      return this.toCanonicalItem(res.data as unknown as IssueLikePayload);
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async getComments(id: string): Promise<Comment[]> {
    const { owner, repo, number } = parseProviderItemId(id);
    try {
      const res = await this.octokit.issues.listComments({
        owner,
        repo,
        issue_number: number,
        per_page: 100,
      });
      return res.data.map(
        (c): Comment => ({
          id: String(c.id),
          itemId: id,
          author: c.user?.login ?? "",
          bodyMd: c.body ?? "",
          createdAt: new Date(c.created_at),
        }),
      );
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async getLinked(_id: string): Promise<Item[]> {
    // GitHub doesn't expose explicit issue-to-issue links via the REST API
    // beyond mentions; the link-tools layer extracts those at agent runtime.
    // Return empty here so the provider stays honest.
    return [];
  }

  async transition(id: string, intent: TransitionIntent): Promise<Item> {
    const { owner, repo, number } = parseProviderItemId(id);
    const plan = planForIntent(intent);
    try {
      const touchesLabels = plan.labelsToAdd.length > 0 || plan.labelsToRemove.length > 0;
      let labels: string[] | undefined;
      if (touchesLabels) {
        const current = await this.octokit.issues.get({ owner, repo, issue_number: number });
        const currentLabels = labelsOf(current.data as unknown as IssueLikePayload);
        labels = mergeLabels(currentLabels, plan);
      }
      const res = await this.octokit.issues.update({
        owner,
        repo,
        issue_number: number,
        state: plan.state,
        state_reason: plan.stateReason ?? undefined,
        ...(labels ? { labels } : {}),
      });
      return this.toCanonicalItem(res.data as unknown as IssueLikePayload);
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async patchDescription(id: string, newMd: string): Promise<Item> {
    const { owner, repo, number } = parseProviderItemId(id);
    try {
      const res = await this.octokit.issues.update({
        owner,
        repo,
        issue_number: number,
        body: newMd,
      });
      return this.toCanonicalItem(res.data as unknown as IssueLikePayload);
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async uploadAttachment(
    _id: string,
    _filename: string,
    _content: Uint8Array,
    _contentType: string,
  ): Promise<string> {
    throw new ProviderError(
      "GitHub REST has no native issue-attachment endpoint; use a comment with a hosted asset.",
    );
  }

  async addComment(id: string, bodyMd: string): Promise<Comment> {
    const { owner, repo, number } = parseProviderItemId(id);
    try {
      const res = await this.octokit.issues.createComment({
        owner,
        repo,
        issue_number: number,
        body: bodyMd,
      });
      const c = res.data;
      return {
        id: String(c.id),
        itemId: id,
        author: c.user?.login ?? "",
        bodyMd: c.body ?? "",
        createdAt: new Date(c.created_at),
      };
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async setTags(id: string, tags: readonly string[]): Promise<Item> {
    const { owner, repo, number } = parseProviderItemId(id);
    try {
      const current = await this.octokit.issues.get({ owner, repo, issue_number: number });
      const currentLabels = labelsOf(current.data as unknown as IssueLikePayload);
      const preserved = currentLabels.filter((l) => STATE_ENCODING_LABELS.has(l.toLowerCase()));
      const seen = new Set(preserved.map((l) => l.toLowerCase()));
      const out = [...preserved];
      for (const tag of tags) {
        const trimmed = tag.trim();
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
      }
      out.sort();
      const res = await this.octokit.issues.update({
        owner,
        repo,
        issue_number: number,
        labels: out,
      });
      return this.toCanonicalItem(res.data as unknown as IssueLikePayload);
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async createItem(_kind: ItemKind, fields: CreateFields): Promise<Item> {
    try {
      const res = await this.octokit.issues.create({
        owner: this.config.owner,
        repo: this.config.repo,
        title: fields.title,
        body: fields.descriptionMd,
        labels: fields.tags.length > 0 ? [...fields.tags] : undefined,
        assignees: fields.assignee ? [fields.assignee] : undefined,
      });
      return this.toCanonicalItem(res.data as unknown as IssueLikePayload);
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async currentUserIdentity(): Promise<string | null> {
    try {
      const res = await this.octokit.users.getAuthenticated();
      return res.data.login;
    } catch {
      return null;
    }
  }

  async findRelatedPRs(_id: string): Promise<PRMatch[]> {
    // The heuristic-based PR matcher is not wired yet. Returning [] keeps
    // the agent's PR tools quiet rather than throwing.
    return [];
  }

  async getPullRequest(prId: string): Promise<PullRequestDetail> {
    const { owner, repo, number } = parseProviderItemId(prId);
    try {
      const [pr, files, reviews] = await Promise.all([
        this.octokit.pulls.get({ owner, repo, pull_number: number }),
        this.octokit.pulls.listFiles({ owner, repo, pull_number: number, per_page: 100 }),
        this.octokit.pulls.listReviews({ owner, repo, pull_number: number, per_page: 100 }),
      ]);
      const data = pr.data;
      return {
        id: prId,
        url: data.html_url,
        title: data.title,
        number: data.number,
        state: data.merged ? "merged" : data.state,
        author: data.user?.login ?? "",
        bodyMd: data.body ?? "",
        headRef: data.head.ref,
        baseRef: data.base.ref,
        headSha: data.head.sha,
        draft: data.draft ?? false,
        merged: data.merged ?? false,
        mergeable: data.mergeable ?? null,
        labels: data.labels.map((l) => l.name).filter((n): n is string => Boolean(n)),
        requestedReviewers: (data.requested_reviewers ?? [])
          .map((r) => r?.login ?? "")
          .filter(Boolean),
        additions: data.additions ?? 0,
        deletions: data.deletions ?? 0,
        changedFiles: data.changed_files ?? 0,
        files: files.data.map((f) => ({
          path: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
        })),
        reviews: reviews.data.map((r) => ({
          author: r.user?.login ?? "",
          state: r.state,
          bodyMd: r.body ?? "",
          submittedAt: r.submitted_at ? new Date(r.submitted_at) : null,
        })),
        commentsCount: data.comments ?? 0,
        reviewCommentsCount: data.review_comments ?? 0,
        updatedAt: data.updated_at ? new Date(data.updated_at) : null,
      };
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async getCommit(sha: string): Promise<CommitDetail> {
    try {
      const res = await this.octokit.repos.getCommit({
        owner: this.config.owner,
        repo: this.config.repo,
        ref: sha,
      });
      const c = res.data;
      return {
        sha: c.sha,
        url: c.html_url,
        author: c.author?.login ?? c.commit.author?.name ?? "",
        authorEmail: c.commit.author?.email ?? "",
        committer: c.committer?.login ?? c.commit.committer?.name ?? "",
        committedAt: c.commit.committer?.date ? new Date(c.commit.committer.date) : null,
        message: c.commit.message,
        parents: c.parents.map((p) => p.sha),
        additions: c.stats?.additions ?? 0,
        deletions: c.stats?.deletions ?? 0,
        files: (c.files ?? []).map((f) => ({
          path: f.filename,
          status: f.status ?? "modified",
          additions: f.additions ?? 0,
          deletions: f.deletions ?? 0,
        })),
      };
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async getCIStatus(ref: string): Promise<CIStatus> {
    try {
      const res = await this.octokit.checks.listForRef({
        owner: this.config.owner,
        repo: this.config.repo,
        ref,
        per_page: 100,
      });
      const runs = res.data.check_runs.map((r) => ({
        id: String(r.id),
        name: r.name,
        status: r.status,
        conclusion: r.conclusion ?? "",
        url: r.html_url ?? "",
        headSha: r.head_sha,
        startedAt: r.started_at ? new Date(r.started_at) : null,
        completedAt: r.completed_at ? new Date(r.completed_at) : null,
      }));
      const overall = (() => {
        if (runs.length === 0) return "none" as const;
        if (runs.some((r) => r.status !== "completed")) return "pending" as const;
        if (runs.some((r) => r.conclusion === "failure" || r.conclusion === "timed_out")) {
          return "failure" as const;
        }
        return "success" as const;
      })();
      return { ref, overall, runs };
    } catch (err) {
      wrapOctokitError(err);
    }
  }
}
