/**
 * GitHub `WorkItemProvider` implementation backed by `@octokit/rest`.
 *
 * Constructed from a config object with shape `{ owner, repo, accessToken }`
 * — the access token comes from the calling user's NextAuth `Account` row
 * for `provider="github"`. The class never reaches into env vars or
 * persistent stores; everything it needs to talk to GitHub is in `config`.
 */

import { Octokit } from "@octokit/rest";
import type { ReactionTarget, WorkItemProvider } from "@/core/provider";
import { ProviderAuthError, ProviderError, wrapProviderError } from "@/core/provider";
import type {
  ChangedItem,
  CIStatus,
  CodeSearchResult,
  Comment,
  CommitDetail,
  CreateFields,
  Item,
  ItemKind,
  PRMatch,
  ProviderItemId,
  PullRequestDetail,
  PullRequestDiff,
  Reactions,
  TransitionIntent,
} from "@/core/types";
import {
  bodyHasClosingKeyword,
  branchMatchesIssue,
  CONFIDENCE_BRANCH_NAME,
  CONFIDENCE_KEYWORD_SEARCH,
  CONFIDENCE_SEARCH_BODY,
  CONFIDENCE_SEARCH_TITLE,
  CONFIDENCE_TIMELINE_CLOSING,
  CONFIDENCE_TIMELINE_CONNECTED,
  CONFIDENCE_TIMELINE_MENTION,
  mergeMatches,
  titleMentionsIssue,
} from "@/providers/github/pr-link-heuristics";
import {
  GITHUB_REACTION_KINDS,
  type GithubReactionKind,
  isGithubReactionKind,
} from "@/providers/github/reactions";
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
  const owner = typeof raw["owner"] === "string" ? raw["owner"] : "";
  const repo = typeof raw["repo"] === "string" ? raw["repo"] : "";
  const accessToken = typeof raw["accessToken"] === "string" ? raw["accessToken"] : "";
  const baseUrl = typeof raw["baseUrl"] === "string" && raw["baseUrl"] ? raw["baseUrl"] : undefined;
  if (!owner || !repo) {
    throw new ProviderError("GitHub provider config is missing 'owner' or 'repo'");
  }
  if (!accessToken) {
    throw new ProviderAuthError(
      "GitHub provider config is missing 'accessToken'; sign in with GitHub first.",
    );
  }
  return { owner, repo, accessToken, ...(baseUrl !== undefined ? { baseUrl } : {}) };
}

function makeProviderItemId(owner: string, repo: string, number: number): ProviderItemId {
  return `${owner}/${repo}#${number}` as ProviderItemId;
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

type GithubReactionsSummary = {
  "+1"?: number;
  "-1"?: number;
  laugh?: number;
  hooray?: number;
  confused?: number;
  heart?: number;
  rocket?: number;
  eyes?: number;
} | null;

/**
 * Structural shape over `octokit.issues.{get,update,list-for-repo}.response.data`.
 * Octokit's response types are operation-tagged with deeply nested fields we
 * don't read; this widened-but-compatible shape lets the TS compiler verify
 * Octokit responses are assignable directly (no casts) while staying
 * permissive enough to also cover search-result rows and inline timeline
 * payloads. Every property is optional/nullable to match the most permissive
 * response — runtime sites guard with `?? ""` / `?? null` already.
 */
type IssueLikePayload = {
  number: number;
  title?: string | null;
  body?: string | null;
  state: string;
  state_reason?: string | null;
  user?: { login?: string | null } | null;
  assignee?: { login?: string | null } | null;
  assignees?: ReadonlyArray<{ login?: string | null } | null> | null;
  labels?: ReadonlyArray<string | { name?: string | null | undefined }>;
  html_url?: string;
  repository_url?: string | null;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
  milestone?: { title?: string | null } | null;
  comments?: number;
  reactions?: GithubReactionsSummary;
  pull_request?: unknown;
};

function labelsOf(issue: IssueLikePayload): string[] {
  return (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
    .filter((name): name is string => Boolean(name));
}

/**
 * Extract a `Reactions` count map from a GitHub reaction summary blob.
 * Returns null when the field is missing entirely (older payload shape);
 * an empty `{}` when there are no reactions yet.
 */
function reactionsOf(raw: GithubReactionsSummary | undefined): Reactions | null {
  if (!raw) return null;
  const out: Reactions = {};
  for (const key of GITHUB_REACTION_KINDS) {
    const v = raw[key];
    if (typeof v === "number" && v > 0) out[key] = v;
  }
  return out;
}

function assertGithubReaction(reaction: string): GithubReactionKind {
  if (isGithubReactionKind(reaction)) return reaction;
  throw new ProviderError(
    `GitHub does not support reaction kind '${reaction}'. Supported: ${GITHUB_REACTION_KINDS.join(", ")}`,
  );
}

type TimelineEvent = {
  event?: string;
  source?: {
    issue?: {
      title?: string | null;
      body?: string | null;
      state?: string | null;
      html_url?: string | null;
      user?: { login?: string | null } | null;
      pull_request?: {
        html_url?: string | null;
        merged_at?: string | null;
      } | null;
    } | null;
  } | null;
};

function derivePRState(state: string | null | undefined, mergedAt: string | null): string {
  if (mergedAt) return "merged";
  return state === "closed" ? "closed" : "open";
}

function wrapOctokitError(err: unknown): never {
  wrapProviderError(err, "GitHub");
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
    const assignees = (issue.assignees ?? [])
      .map((a) => a?.login ?? "")
      .filter((login): login is string => Boolean(login));
    const singleAssignee = issue.assignee?.login ?? null;
    return {
      id: makeProviderItemId(this.config.owner, this.config.repo, issue.number),
      kind: inferKind(labels),
      title: issue.title ?? "",
      description: issue.body ?? "",
      state: toCanonicalState(
        {
          state: issue.state as GithubIssueState,
          stateReason: (issue.state_reason ?? null) as GithubStateReason,
        },
        labels,
      ),
      assignee: singleAssignee,
      assignees: assignees.length > 0 ? assignees : singleAssignee ? [singleAssignee] : [],
      reviewers: [],
      linkedItemIds: [],
      reactions: reactionsOf(issue.reactions),
      milestone: issue.milestone?.title ?? null,
      iteration: null,
      area: null,
      ciSummary: null,
      author: issue.user?.login ?? null,
      parentId: null,
      tags: labels,
      createdAt: issue.created_at ? new Date(issue.created_at) : new Date(0),
      updatedAt: issue.updated_at ? new Date(issue.updated_at) : new Date(0),
      closedAt: issue.closed_at ? new Date(issue.closed_at) : null,
      url: issue.html_url ?? null,
      repositoryUrl: `https://github.com/${this.config.owner}/${this.config.repo}`,
      attachments: [],
      providerRaw: { ...issue },
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

  async *listChangesSince(watermark: Date | null): AsyncIterable<ChangedItem> {
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
          const item = this.toCanonicalItem(issue);
          // Fetch comments inline so the cache stays current without an extra
          // refresh round-trip from the UI. Skip the call entirely when the
          // payload's `comments` count is 0 — common path on small issues.
          let comments: Comment[] | null;
          if ((issue.comments ?? 0) === 0) {
            comments = [];
          } else {
            try {
              comments = await this.fetchComments(item.id);
            } catch {
              // Don't let one issue's comment fetch fail the whole sync; fall
              // through to "skip comment reconciliation" so the next refresh
              // tries again.
              comments = null;
            }
          }
          yield { item, comments };
        }
      }
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  private async fetchComments(id: string): Promise<Comment[]> {
    const { owner, repo, number } = parseProviderItemId(id);
    const all = await this.octokit.paginate(this.octokit.issues.listComments, {
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    });
    return all.map((c): Comment => {
      const created = new Date(c.created_at);
      const updated = c.updated_at ? new Date(c.updated_at) : null;
      const reactions = reactionsOf((c as { reactions?: GithubReactionsSummary }).reactions);
      return {
        id: String(c.id),
        itemId: id,
        author: c.user?.login ?? "",
        body: c.body ?? "",
        createdAt: created,
        updatedAt: updated,
        edited: updated ? updated.getTime() > created.getTime() : false,
        reactions,
      };
    });
  }

  async getItem(id: string): Promise<Item> {
    const { owner, repo, number } = parseProviderItemId(id);
    try {
      const res = await this.octokit.issues.get({ owner, repo, issue_number: number });
      return this.toCanonicalItem(res.data);
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async getComments(id: string): Promise<Comment[]> {
    try {
      return await this.fetchComments(id);
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
        const currentLabels = labelsOf(current.data);
        labels = mergeLabels(currentLabels, plan);
      }
      const res = await this.octokit.issues.update({
        owner,
        repo,
        issue_number: number,
        state: plan.state,
        ...(plan.stateReason ? { state_reason: plan.stateReason } : {}),
        ...(labels ? { labels } : {}),
      });
      return this.toCanonicalItem(res.data);
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async patchDescription(id: string, newDescription: string): Promise<Item> {
    const { owner, repo, number } = parseProviderItemId(id);
    try {
      const res = await this.octokit.issues.update({
        owner,
        repo,
        issue_number: number,
        body: newDescription,
      });
      return this.toCanonicalItem(res.data);
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

  async addComment(id: string, body: string): Promise<Comment> {
    const { owner, repo, number } = parseProviderItemId(id);
    try {
      const res = await this.octokit.issues.createComment({
        owner,
        repo,
        issue_number: number,
        body: body,
      });
      const c = res.data;
      const created = new Date(c.created_at);
      const updated = c.updated_at ? new Date(c.updated_at) : null;
      return {
        id: String(c.id),
        itemId: id,
        author: c.user?.login ?? "",
        body: c.body ?? "",
        createdAt: created,
        updatedAt: updated,
        edited: updated ? updated.getTime() > created.getTime() : false,
        reactions: reactionsOf((c as { reactions?: GithubReactionsSummary }).reactions),
      };
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async addReaction(target: ReactionTarget, reaction: string): Promise<{ reactions: Reactions }> {
    const content = assertGithubReaction(reaction);
    try {
      if (target.kind === "item") {
        const { owner, repo, number } = parseProviderItemId(target.id);
        await this.octokit.reactions.createForIssue({
          owner,
          repo,
          issue_number: number,
          content,
        });
        const updated = await this.octokit.issues.get({ owner, repo, issue_number: number });
        return {
          reactions:
            reactionsOf((updated.data as { reactions?: GithubReactionsSummary }).reactions) ?? {},
        };
      }
      const commentNumber = Number.parseInt(target.id, 10);
      await this.octokit.reactions.createForIssueComment({
        owner: this.config.owner,
        repo: this.config.repo,
        comment_id: commentNumber,
        content,
      });
      const refreshed = await this.octokit.issues.getComment({
        owner: this.config.owner,
        repo: this.config.repo,
        comment_id: commentNumber,
      });
      return {
        reactions:
          reactionsOf((refreshed.data as { reactions?: GithubReactionsSummary }).reactions) ?? {},
      };
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async removeReaction(
    target: ReactionTarget,
    reaction: string,
  ): Promise<{ reactions: Reactions }> {
    // GitHub's reaction-delete endpoints take a reaction id, not a (target,
    // content) pair. We list the user's reactions on the target, find the one
    // matching `reaction`, and DELETE it. The list is small (one row per
    // user/content combination), so the round-trip is cheap.
    const content = assertGithubReaction(reaction);
    try {
      if (target.kind === "item") {
        const { owner, repo, number } = parseProviderItemId(target.id);
        const me = await this.octokit.users.getAuthenticated();
        const myLogin = me.data.login;
        const reactions = await this.octokit.paginate(this.octokit.reactions.listForIssue, {
          owner,
          repo,
          issue_number: number,
          per_page: 100,
          content,
        });
        const mine = reactions.find((r) => r.user?.login === myLogin);
        if (mine) {
          await this.octokit.reactions.deleteForIssue({
            owner,
            repo,
            issue_number: number,
            reaction_id: mine.id,
          });
        }
        const updated = await this.octokit.issues.get({ owner, repo, issue_number: number });
        return {
          reactions:
            reactionsOf((updated.data as { reactions?: GithubReactionsSummary }).reactions) ?? {},
        };
      }
      const commentNumber = Number.parseInt(target.id, 10);
      const me = await this.octokit.users.getAuthenticated();
      const myLogin = me.data.login;
      const reactions = await this.octokit.paginate(this.octokit.reactions.listForIssueComment, {
        owner: this.config.owner,
        repo: this.config.repo,
        comment_id: commentNumber,
        per_page: 100,
        content,
      });
      const mine = reactions.find((r) => r.user?.login === myLogin);
      if (mine) {
        await this.octokit.reactions.deleteForIssueComment({
          owner: this.config.owner,
          repo: this.config.repo,
          comment_id: commentNumber,
          reaction_id: mine.id,
        });
      }
      const refreshed = await this.octokit.issues.getComment({
        owner: this.config.owner,
        repo: this.config.repo,
        comment_id: commentNumber,
      });
      return {
        reactions:
          reactionsOf((refreshed.data as { reactions?: GithubReactionsSummary }).reactions) ?? {},
      };
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async setTags(id: string, tags: readonly string[]): Promise<Item> {
    const { owner, repo, number } = parseProviderItemId(id);
    try {
      const current = await this.octokit.issues.get({ owner, repo, issue_number: number });
      const currentLabels = labelsOf(current.data);
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
      return this.toCanonicalItem(res.data);
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async setAssignee(id: string, assignee: string | null): Promise<Item> {
    const { owner, repo, number } = parseProviderItemId(id);
    try {
      // GitHub stores a multi-assignee set; our canonical model is a single
      // assignee. Replace the entire set so an existing co-assignee can't
      // shadow the change. PATCH /issues/:n with `assignees` is the only
      // endpoint that overwrites; the dedicated add/remove endpoints only
      // mutate deltas.
      const res = await this.octokit.issues.update({
        owner,
        repo,
        issue_number: number,
        assignees: assignee ? [assignee] : [],
      });
      return this.toCanonicalItem(res.data);
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
        body: fields.description,
        ...(fields.tags.length > 0 ? { labels: [...fields.tags] } : {}),
        ...(fields.assignee ? { assignees: [fields.assignee] } : {}),
      });
      return this.toCanonicalItem(res.data);
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

  async findRelatedPRs(id: string): Promise<PRMatch[]> {
    const { owner, repo, number } = parseProviderItemId(id);
    // Run all three signals in parallel; settle individually so a flaky search
    // endpoint or a rate-limited timeline doesn't blank out the others. Only
    // throw if every probe failed — "no signal" and "everything failed" are
    // genuinely different answers.
    const [timelineRes, searchRes, branchRes] = await Promise.allSettled([
      this.collectTimelineMatches(owner, repo, number),
      this.collectSearchMatches(owner, repo, number),
      this.collectBranchMatches(owner, repo, number),
    ]);
    const all: PRMatch[] = [];
    if (timelineRes.status === "fulfilled") all.push(...timelineRes.value);
    if (searchRes.status === "fulfilled") all.push(...searchRes.value);
    if (branchRes.status === "fulfilled") all.push(...branchRes.value);
    if (
      timelineRes.status === "rejected" &&
      searchRes.status === "rejected" &&
      branchRes.status === "rejected"
    ) {
      wrapOctokitError(timelineRes.reason);
    }
    return mergeMatches(all);
  }

  private async collectTimelineMatches(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PRMatch[]> {
    const events = await this.octokit.paginate(this.octokit.issues.listEventsForTimeline, {
      owner,
      repo,
      issue_number: number,
      per_page: 100,
    });
    const out: PRMatch[] = [];
    for (const event of events as readonly TimelineEvent[]) {
      const ev = event.event;
      if (ev !== "cross-referenced" && ev !== "connected") continue;
      const source = event.source?.issue;
      if (!source?.pull_request) continue;
      const url = source.pull_request.html_url ?? source.html_url ?? "";
      if (!url) continue;
      const body = source.body ?? "";
      const closing = bodyHasClosingKeyword(body, number);
      const confidence =
        ev === "connected"
          ? CONFIDENCE_TIMELINE_CONNECTED
          : closing
            ? CONFIDENCE_TIMELINE_CLOSING
            : CONFIDENCE_TIMELINE_MENTION;
      out.push({
        url,
        title: source.title ?? "",
        branch: "",
        state: derivePRState(source.state, source.pull_request.merged_at ?? null),
        author: source.user?.login ?? "",
        confidence,
      });
    }
    return out;
  }

  private async collectSearchMatches(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PRMatch[]> {
    const q = `repo:${owner}/${repo} type:pr ${number} in:title,body`;
    const res = await this.octokit.search.issuesAndPullRequests({ q, per_page: 50 });
    const out: PRMatch[] = [];
    for (const item of res.data.items) {
      if (!item.pull_request) continue;
      const url = item.pull_request.html_url ?? item.html_url;
      if (!url) continue;
      const titleHit = titleMentionsIssue(item.title ?? "", number);
      out.push({
        url,
        title: item.title ?? "",
        branch: "",
        state: derivePRState(item.state, item.pull_request.merged_at ?? null),
        author: item.user?.login ?? "",
        confidence: titleHit ? CONFIDENCE_SEARCH_TITLE : CONFIDENCE_SEARCH_BODY,
      });
    }
    return out;
  }

  private async collectBranchMatches(
    owner: string,
    repo: string,
    number: number,
  ): Promise<PRMatch[]> {
    const prs = await this.octokit.pulls.list({
      owner,
      repo,
      state: "all",
      per_page: 100,
      sort: "updated",
      direction: "desc",
    });
    const out: PRMatch[] = [];
    for (const pr of prs.data) {
      const branch = pr.head?.ref ?? "";
      if (!branchMatchesIssue(branch, number)) continue;
      out.push({
        url: pr.html_url,
        title: pr.title,
        branch,
        state: derivePRState(pr.state, pr.merged_at ?? null),
        author: pr.user?.login ?? "",
        confidence: CONFIDENCE_BRANCH_NAME,
      });
    }
    return out;
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
        body: data.body ?? "",
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
          body: r.body ?? "",
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

  async getPullRequestDiff(prId: string): Promise<PullRequestDiff> {
    const { owner, repo, number } = parseProviderItemId(prId);
    try {
      const files = await this.octokit.pulls.listFiles({
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      });
      return {
        id: prId,
        files: files.data.map((f) => ({
          path: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ?? null,
        })),
      };
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async searchPullRequests(
    query: string,
    opts: { state: "open" | "closed" | "merged" | "all"; limit: number },
  ): Promise<PRMatch[]> {
    // Scope to the project's configured repo so the agent can't accidentally
    // pull in PRs from forks or other repos sharing the owner. Confidence
    // is fixed at the keyword-search floor — there's no explicit link
    // signal, only a topic match, so the agent should always verify a hit
    // by reading the PR before proposing anything.
    const stateFilter = opts.state === "all" ? "" : ` is:${opts.state}`;
    const q = `repo:${this.config.owner}/${this.config.repo} type:pr${stateFilter} ${query}`;
    try {
      const res = await this.octokit.search.issuesAndPullRequests({
        q,
        per_page: Math.min(Math.max(opts.limit, 1), 50),
      });
      const out: PRMatch[] = [];
      for (const item of res.data.items) {
        if (!item.pull_request) continue;
        const url = item.pull_request.html_url ?? item.html_url;
        if (!url) continue;
        out.push({
          url,
          title: item.title ?? "",
          branch: "",
          state: derivePRState(item.state, item.pull_request.merged_at ?? null),
          author: item.user?.login ?? "",
          confidence: CONFIDENCE_KEYWORD_SEARCH,
        });
      }
      return out;
    } catch (err) {
      wrapOctokitError(err);
    }
  }

  async searchCode(query: string, limit: number): Promise<CodeSearchResult> {
    // Constrain the search to the configured repo so the result set isn't
    // polluted by hits from forks or unrelated public repos sharing the
    // owner. The agent can still pass repo-qualified terms in `query` if
    // it wants to widen the scope deliberately.
    const scoped = `${query} repo:${this.config.owner}/${this.config.repo}`;
    try {
      const res = await this.octokit.search.code({
        q: scoped,
        per_page: Math.min(Math.max(limit, 1), 50),
      });
      return {
        query,
        total: res.data.total_count,
        items: res.data.items.map((i) => ({
          repository: i.repository.full_name,
          path: i.path,
          url: i.html_url,
        })),
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
