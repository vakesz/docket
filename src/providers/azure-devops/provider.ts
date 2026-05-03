// Description / comment bodies are HTML on AzDO and round-trip as-is —
// no HTML→Markdown converter wired yet. PR / commit / CI methods are
// intentionally absent: AzDO Boards items don't carry git-host signals,
// and the agent's PR tools tolerate providers that don't implement them.

import { Readable } from "node:stream";
import * as azdev from "azure-devops-node-api";
import type { IGitApi } from "azure-devops-node-api/GitApi.js";
import {
  type JsonPatchOperation,
  Operation,
} from "azure-devops-node-api/interfaces/common/VSSInterfaces.js";
import {
  type Comment as AzdoComment,
  type WorkItem,
  WorkItemErrorPolicy,
  WorkItemExpand,
} from "azure-devops-node-api/interfaces/WorkItemTrackingInterfaces.js";
import type { IWorkItemTrackingApi } from "azure-devops-node-api/WorkItemTrackingApi.js";
import type { WorkItemProvider } from "@/core/provider";
import { ProviderAuthError, ProviderError, wrapProviderError } from "@/core/provider";
import type {
  ChangedItem,
  Comment,
  CreateFields,
  Item,
  ItemKind,
  PRMatch,
  ProviderItemId,
  PullRequestDetail,
  PullRequestFile,
  PullRequestReview,
  TransitionIntent,
} from "@/core/types";
import { asPlainObject } from "@/lib/json";
import {
  AZDO_PR_STATUS,
  DEFAULT_WORKITEM_FIELDS,
  MAX_BATCH_IDS,
} from "@/providers/azure-devops/constants";
import {
  changeTypeToStatus,
  parseAzdoPullRequestId,
  parseVstfsPRRef,
  pullRequestStatusToCanonical,
  stripRefPrefix,
  voteToReviewState,
} from "@/providers/azure-devops/pr-link";
import {
  KIND_BY_WIT,
  mapState,
  mergeTags,
  planForIntent,
  STATE_ENCODING_TAGS,
  WIT_BY_KIND,
} from "@/providers/azure-devops/state-map";

type Config = {
  orgUrl: string;
  project: string;
  accessToken: string;
};

function readConfig(raw: Record<string, unknown>): Config {
  const orgUrl = typeof raw["orgUrl"] === "string" ? raw["orgUrl"].trim() : "";
  const project = typeof raw["project"] === "string" ? raw["project"] : "";
  const accessToken = typeof raw["accessToken"] === "string" ? raw["accessToken"] : "";
  if (!orgUrl) {
    throw new ProviderError("Azure DevOps provider config is missing 'orgUrl'");
  }
  if (!project) {
    throw new ProviderError("Azure DevOps provider config is missing 'project'");
  }
  if (!accessToken) {
    throw new ProviderAuthError(
      "Azure DevOps provider config is missing 'accessToken'; sign in with Azure DevOps first.",
    );
  }
  return { orgUrl: orgUrl.replace(/\/$/, ""), project, accessToken };
}

function wrapError(err: unknown): never {
  wrapProviderError(err, "Azure DevOps");
}

function parseTags(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw.filter((v): v is string => typeof v === "string" && v.trim() !== "");
  }
  // AzDO encodes tags as "a; b; c"
  return String(raw)
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean);
}

function readAssignee(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "string") return raw;
  const obj = asPlainObject(raw);
  const unique = obj["uniqueName"] ?? obj["unique_name"];
  if (typeof unique === "string" && unique) return unique;
  const display = obj["displayName"] ?? obj["display_name"];
  if (typeof display === "string" && display) return display;
  return null;
}

function readDate(raw: unknown): Date | null {
  if (!raw) return null;
  if (raw instanceof Date) return raw;
  if (typeof raw === "string" || typeof raw === "number") {
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function readString(raw: unknown): string | null {
  return typeof raw === "string" ? raw : null;
}

/**
 * Local alias for the SDK's `WorkItem` so call sites read fluently and a
 * future structural divergence is a one-line edit. Using the SDK type
 * directly removes the need for `as unknown as` casts on every API
 * response — `wit.getWorkItem(...)` and friends already produce this shape.
 */
type WorkItemPayload = WorkItem;

type VstfsRef = NonNullable<ReturnType<typeof parseVstfsPRRef>>;

export class AzureDevOpsProvider implements WorkItemProvider {
  private readonly config: Config;
  private readonly providerKey: string;
  private wit: IWorkItemTrackingApi | null = null;
  private git: IGitApi | null = null;
  private conn: azdev.WebApi | null = null;

  constructor(rawConfig: Record<string, unknown>) {
    this.config = readConfig(rawConfig);
    this.providerKey = `azure_devops:${this.config.orgUrl}/${this.config.project}`;
  }

  private connection(): azdev.WebApi {
    if (!this.conn) {
      const handler = azdev.getBearerHandler(this.config.accessToken);
      this.conn = new azdev.WebApi(this.config.orgUrl, handler);
    }
    return this.conn;
  }

  private async witApi(): Promise<IWorkItemTrackingApi> {
    if (!this.wit) {
      this.wit = await this.connection().getWorkItemTrackingApi();
    }
    return this.wit;
  }

  private async gitApi(): Promise<IGitApi> {
    if (!this.git) {
      this.git = await this.connection().getGitApi();
    }
    return this.git;
  }

  private webUrl(workItemId: number | string): string {
    return `${this.config.orgUrl}/${encodeURIComponent(this.config.project)}/_workitems/edit/${workItemId}`;
  }

  private toCanonicalItem(payload: WorkItemPayload): Item | null {
    const fields = payload.fields ?? {};
    const witType = fields["System.WorkItemType"];
    const wit = typeof witType === "string" ? witType : "";
    const kind = KIND_BY_WIT[wit];
    if (!kind) return null;
    const idRaw = String(payload.id ?? fields["System.Id"] ?? "");
    if (!idRaw) return null;
    const id = idRaw as ProviderItemId;
    const tags = parseTags(fields["System.Tags"]);
    const stateField = fields["System.State"];
    const stateString = typeof stateField === "string" ? stateField : "";
    const parentRaw = fields["System.Parent"];
    const parent: ProviderItemId | null =
      typeof parentRaw === "number"
        ? (String(parentRaw) as ProviderItemId)
        : typeof parentRaw === "string" && parentRaw
          ? (parentRaw as ProviderItemId)
          : null;
    const assignee = readAssignee(fields["System.AssignedTo"]);
    const linkedItemIds: ProviderItemId[] = [];
    for (const rel of payload.relations ?? []) {
      const relType = rel.rel ?? "";
      if (!relType.startsWith("System.LinkTypes.") && !relType.startsWith("Microsoft.VSTS")) {
        continue;
      }
      const url = rel.url ?? "";
      const tail = url.replace(/\/+$/, "").split("/").pop() ?? "";
      if (/^\d+$/.test(tail) && tail !== id) linkedItemIds.push(tail as ProviderItemId);
    }
    const iteration = readString(fields["System.IterationPath"]);
    const area = readString(fields["System.AreaPath"]);
    return {
      id,
      kind,
      title: readString(fields["System.Title"]) ?? "",
      description: readString(fields["System.Description"]) ?? "",
      state: mapState(kind, stateString, tags),
      assignee,
      assignees: assignee ? [assignee] : [],
      reviewers: [],
      linkedItemIds,
      reactions: null,
      milestone: null,
      iteration,
      area,
      ciSummary: null,
      parentId: parent,
      tags,
      createdAt: readDate(fields["System.CreatedDate"]),
      updatedAt: readDate(fields["System.ChangedDate"]),
      closedAt: readDate(fields["Microsoft.VSTS.Common.ClosedDate"]),
      url: this.webUrl(id),
      author: null,
      repositoryUrl: null,
      attachments: [],
      providerRaw: { ...payload },
      providerKey: this.providerKey,
    };
  }

  async healthCheck(): Promise<void> {
    try {
      const wit = await this.witApi();
      await wit.queryByWiql(
        {
          query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = '${escapeWiql(this.config.project)}' AND [System.Id] = -1`,
        },
        { project: this.config.project },
      );
    } catch (err) {
      wrapError(err);
    }
  }

  async currentUserIdentity(): Promise<string | null> {
    // Profile API is on the vssps subdomain; the SDK's profile client returns
    // the same email the assignee field uses. Wrap in try/catch and degrade
    // to null so `@me` falls back to "no narrowing" instead of hiding rows.
    try {
      const profile = await this.connection().getProfileApi();
      // Profile responses from the v1.0 endpoint carry `emailAddress` and
      // `displayName` on the wire even though the SDK's `Profile` interface
      // only models `coreAttributes`. A single bridge cast keeps the access
      // honest.
      const me = (await profile.getProfile("me")) as unknown as {
        emailAddress?: string;
        displayName?: string;
      };
      return me.emailAddress || me.displayName || null;
    } catch {
      return null;
    }
  }

  async *listChangesSince(watermark: Date | null): AsyncIterable<ChangedItem> {
    const wit = await this.witApi();
    const types = Object.keys(KIND_BY_WIT)
      .map((t) => `'${t.replaceAll("'", "''")}'`)
      .join(", ");
    const clauses = [
      `[System.TeamProject] = '${escapeWiql(this.config.project)}'`,
      `[System.WorkItemType] IN (${types})`,
    ];
    if (watermark) {
      clauses.push(`[System.ChangedDate] >= '${watermark.toISOString()}'`);
    }
    const wiql = `SELECT [System.Id] FROM WorkItems WHERE ${clauses.join(" AND ")} ORDER BY [System.ChangedDate] ASC`;
    let result: Awaited<ReturnType<typeof wit.queryByWiql>>;
    try {
      result = await wit.queryByWiql({ query: wiql }, { project: this.config.project });
    } catch (err) {
      wrapError(err);
    }
    const ids = (result.workItems ?? [])
      .map((ref) => ref.id)
      .filter((id): id is number => typeof id === "number");
    for (let i = 0; i < ids.length; i += MAX_BATCH_IDS) {
      const chunk = ids.slice(i, i + MAX_BATCH_IDS);
      let batch: Awaited<ReturnType<typeof wit.getWorkItems>>;
      try {
        // Pass `expand: All` (instead of the field projection) so relations
        // ride along — toCanonicalItem reads them to populate linkedItemIds.
        batch = await wit.getWorkItems(
          chunk,
          undefined,
          undefined,
          WorkItemExpand.All,
          WorkItemErrorPolicy.Omit,
        );
      } catch (err) {
        wrapError(err);
      }
      for (const raw of batch ?? []) {
        if (!raw) continue;
        const payload = raw;
        const item = this.toCanonicalItem(payload);
        if (!item) continue;
        const commentCount = payload.fields?.["System.CommentCount"];
        const numericCount = typeof commentCount === "number" ? commentCount : 0;
        let comments: Comment[] | null;
        if (numericCount === 0) {
          comments = [];
        } else {
          try {
            comments = await this.fetchComments(item.id);
          } catch {
            comments = null;
          }
        }
        yield { item, comments };
      }
    }
  }

  private async fetchComments(id: string): Promise<Comment[]> {
    const wit = await this.witApi();
    const resp = await wit.getComments(this.config.project, Number.parseInt(id, 10));
    const comments: AzdoComment[] = resp.comments ?? [];
    return comments.map((c) => {
      const author = c.createdBy?.uniqueName || c.createdBy?.displayName || "unknown";
      const created = c.createdDate ?? new Date();
      const modified = c.modifiedDate ?? null;
      return {
        id: String(c.id ?? ""),
        itemId: id,
        author,
        body: c.text ?? "",
        createdAt: created,
        updatedAt: modified ?? null,
        edited: modified ? modified.getTime() > created.getTime() : false,
        reactions: null,
      };
    });
  }

  async getItem(id: string): Promise<Item> {
    const wit = await this.witApi();
    try {
      const raw = await wit.getWorkItem(
        Number.parseInt(id, 10),
        [...DEFAULT_WORKITEM_FIELDS],
        undefined,
        WorkItemExpand.All,
      );
      const item = this.toCanonicalItem(raw);
      if (!item) {
        throw new ProviderError(`Work item ${id} is not a tracked type`);
      }
      return item;
    } catch (err) {
      wrapError(err);
    }
  }

  async getComments(id: string): Promise<Comment[]> {
    try {
      return await this.fetchComments(id);
    } catch (err) {
      wrapError(err);
    }
  }

  async getLinked(id: string): Promise<Item[]> {
    const wit = await this.witApi();
    let raw: Awaited<ReturnType<typeof wit.getWorkItem>>;
    try {
      raw = await wit.getWorkItem(
        Number.parseInt(id, 10),
        undefined,
        undefined,
        WorkItemExpand.Relations,
      );
    } catch (err) {
      wrapError(err);
    }
    const relations = raw.relations ?? [];
    const relatedIds: number[] = [];
    for (const rel of relations) {
      const url = rel.url ?? "";
      const tail = url.replace(/\/+$/, "").split("/").pop() ?? "";
      if (/^\d+$/.test(tail)) relatedIds.push(Number.parseInt(tail, 10));
    }
    if (relatedIds.length === 0) return [];
    let batch: Awaited<ReturnType<typeof wit.getWorkItems>>;
    try {
      batch = await wit.getWorkItems(
        relatedIds,
        [...DEFAULT_WORKITEM_FIELDS],
        undefined,
        undefined,
        WorkItemErrorPolicy.Omit,
      );
    } catch (err) {
      wrapError(err);
    }
    const out: Item[] = [];
    for (const r of batch ?? []) {
      if (!r) continue;
      const item = this.toCanonicalItem(r);
      if (item) out.push(item);
    }
    return out;
  }

  async transition(id: string, intent: TransitionIntent): Promise<Item> {
    const current = await this.getItem(id);
    const plan = planForIntent(intent);
    const newTags = mergeTags(current.tags, plan);
    const patch: JsonPatchOperation[] = [];
    if (plan.state !== null) {
      patch.push({ op: Operation.Add, path: "/fields/System.State", value: plan.state });
    }
    patch.push({
      op: Operation.Add,
      path: "/fields/System.Tags",
      value: newTags.join("; "),
    });
    const wit = await this.witApi();
    try {
      const raw = await wit.updateWorkItem(null, patch, Number.parseInt(id, 10));
      const item = this.toCanonicalItem(raw);
      if (!item) {
        throw new ProviderError(`Work item ${id} is not a tracked type after update`);
      }
      return item;
    } catch (err) {
      wrapError(err);
    }
  }

  async patchDescription(id: string, newDescription: string): Promise<Item> {
    const patch: JsonPatchOperation[] = [
      { op: Operation.Add, path: "/fields/System.Description", value: newDescription },
    ];
    const wit = await this.witApi();
    try {
      const raw = await wit.updateWorkItem(null, patch, Number.parseInt(id, 10));
      const item = this.toCanonicalItem(raw);
      if (!item) {
        throw new ProviderError(`Work item ${id} is not a tracked type after update`);
      }
      return item;
    } catch (err) {
      wrapError(err);
    }
  }

  async uploadAttachment(
    id: string,
    filename: string,
    content: Uint8Array,
    _contentType: string,
  ): Promise<string> {
    // AzDO splits attachment upload into two calls: blob upload, then relation
    // attach. The SDK's createAttachment wants a NodeJS.ReadableStream, so wrap
    // the in-memory bytes via Readable.from(Buffer.from(...)). contentType is
    // intentionally unused — AzDO infers it server-side and the parameter
    // exists only for interface symmetry with GitHub.
    const wit = await this.witApi();
    const stream = Readable.from(Buffer.from(content));
    let ref: Awaited<ReturnType<typeof wit.createAttachment>>;
    try {
      ref = await wit.createAttachment(null, stream, filename, "Simple", this.config.project);
    } catch (err) {
      wrapError(err);
    }
    const url = ref.url;
    if (!url) {
      throw new ProviderError("Azure DevOps createAttachment returned no url");
    }
    const patch: JsonPatchOperation[] = [
      {
        op: Operation.Add,
        path: "/relations/-",
        value: {
          rel: "AttachedFile",
          url,
          attributes: { name: filename, comment: "" },
        },
      },
    ];
    try {
      await wit.updateWorkItem(null, patch, Number.parseInt(id, 10));
    } catch (err) {
      // The blob is uploaded but unreferenced. AzDO doesn't expose a clean
      // delete-attachment-without-relation path, and orphan blobs are GC'd
      // eventually; surface the relation-add failure rather than papering over.
      wrapError(err);
    }
    return url;
  }

  async findRelatedPRs(id: string): Promise<PRMatch[]> {
    const workItemId = Number.parseInt(id, 10);
    if (!Number.isFinite(workItemId)) {
      throw new ProviderError(`Invalid Azure DevOps work item id: ${id}`);
    }
    const wit = await this.witApi();
    let raw: Awaited<ReturnType<typeof wit.getWorkItem>>;
    try {
      raw = await wit.getWorkItem(workItemId, undefined, undefined, WorkItemExpand.Relations);
    } catch (err) {
      wrapError(err);
    }
    const relations = raw.relations ?? [];
    const refs: VstfsRef[] = [];
    for (const rel of relations) {
      if (rel.rel !== "ArtifactLink") continue;
      const url = rel.url ?? "";
      const parsed = parseVstfsPRRef(url);
      if (!parsed) continue;
      refs.push(parsed);
    }
    if (refs.length === 0) return [];
    let git: IGitApi;
    try {
      git = await this.gitApi();
    } catch (err) {
      wrapError(err);
    }
    const settled = await Promise.allSettled(
      refs.map((ref) => git.getPullRequestById(ref.pullRequestId, this.config.project)),
    );
    const matches: PRMatch[] = [];
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      const pr = result.value;
      const url = this.webPullRequestUrl(pr.repository?.name ?? "", pr.pullRequestId ?? 0);
      if (!url) continue;
      matches.push({
        url,
        title: pr.title ?? "",
        branch: stripRefPrefix(pr.sourceRefName),
        state: pullRequestStatusToCanonical(
          pr.status === undefined ? undefined : Number(pr.status),
        ),
        author: pr.createdBy?.uniqueName ?? pr.createdBy?.displayName ?? "",
        confidence: 0.95,
      });
    }
    return matches;
  }

  async getPullRequest(prId: string): Promise<PullRequestDetail> {
    const num = parseAzdoPullRequestId(prId);
    if (num === null) {
      throw new ProviderError(`Invalid Azure DevOps pullRequestId: ${prId}`);
    }
    let git: IGitApi;
    try {
      git = await this.gitApi();
    } catch (err) {
      wrapError(err);
    }
    let pr: Awaited<ReturnType<typeof git.getPullRequestById>>;
    try {
      pr = await git.getPullRequestById(num, this.config.project);
    } catch (err) {
      wrapError(err);
    }
    const reviews: PullRequestReview[] = (pr.reviewers ?? []).map((r) => ({
      author: r.uniqueName ?? r.displayName ?? "",
      state: voteToReviewState(r.vote ?? 0),
      body: "",
      submittedAt: null,
    }));
    let files: PullRequestFile[] = [];
    if (pr.repository?.id && typeof pr.pullRequestId === "number") {
      try {
        const iters = await git.getPullRequestIterations(
          pr.repository.id,
          pr.pullRequestId,
          this.config.project,
        );
        const lastIter = iters[iters.length - 1];
        if (typeof lastIter?.id === "number") {
          const changes = await git.getPullRequestIterationChanges(
            pr.repository.id,
            pr.pullRequestId,
            lastIter.id,
            this.config.project,
          );
          files = (changes.changeEntries ?? []).map((c) => ({
            path: c.item?.path ?? "",
            status: changeTypeToStatus(
              c.changeType === undefined ? undefined : Number(c.changeType),
            ),
            additions: 0,
            deletions: 0,
          }));
        }
      } catch {
        // File-list discovery failing should not blank the rest of the
        // detail payload — the agent gets metadata even if change-walk 404s.
      }
    }
    const status = pr.status === undefined ? undefined : Number(pr.status);
    const repoName = pr.repository?.name ?? "";
    const url = this.webPullRequestUrl(repoName, pr.pullRequestId ?? num);
    return {
      id: prId,
      url,
      title: pr.title ?? "",
      number: pr.pullRequestId ?? num,
      state: pullRequestStatusToCanonical(status),
      author: pr.createdBy?.uniqueName ?? pr.createdBy?.displayName ?? "",
      body: pr.description ?? "",
      headRef: stripRefPrefix(pr.sourceRefName),
      baseRef: stripRefPrefix(pr.targetRefName),
      headSha: pr.lastMergeSourceCommit?.commitId ?? "",
      draft: pr.isDraft ?? false,
      merged: status === AZDO_PR_STATUS.Completed,
      mergeable: null,
      labels: (pr.labels ?? []).map((l) => l.name ?? "").filter((n): n is string => Boolean(n)),
      requestedReviewers: (pr.reviewers ?? [])
        .map((r) => r.uniqueName ?? r.displayName ?? "")
        .filter((n) => Boolean(n)),
      additions: 0,
      deletions: 0,
      changedFiles: files.length,
      files,
      reviews,
      commentsCount: 0,
      reviewCommentsCount: 0,
      updatedAt: pr.closedDate ?? pr.creationDate ?? null,
    };
  }

  private webPullRequestUrl(repoName: string, pullRequestId: number): string {
    if (!repoName || !pullRequestId) return "";
    return `${this.config.orgUrl}/${encodeURIComponent(this.config.project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${pullRequestId}`;
  }

  async addComment(id: string, body: string): Promise<Comment> {
    const wit = await this.witApi();
    try {
      const resp = await wit.addComment(
        { text: body },
        this.config.project,
        Number.parseInt(id, 10),
      );
      const created = resp.createdDate ?? new Date();
      const modified = resp.modifiedDate ?? null;
      return {
        id: String(resp.id ?? ""),
        itemId: id,
        author: resp.createdBy?.uniqueName || resp.createdBy?.displayName || "unknown",
        body: resp.text ?? body,
        createdAt: created,
        updatedAt: modified ?? null,
        edited: modified ? modified.getTime() > created.getTime() : false,
        reactions: null,
      };
    } catch (err) {
      wrapError(err);
    }
  }

  async setTags(id: string, tags: readonly string[]): Promise<Item> {
    const current = await this.getItem(id);
    const preserved = current.tags.filter((t) => STATE_ENCODING_TAGS.has(t.toLowerCase()));
    const seen = new Set(preserved.map((t) => t.toLowerCase()));
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
    const patch: JsonPatchOperation[] = [
      {
        op: Operation.Add,
        path: "/fields/System.Tags",
        value: out.join("; "),
      },
    ];
    const wit = await this.witApi();
    try {
      const raw = await wit.updateWorkItem(null, patch, Number.parseInt(id, 10));
      const item = this.toCanonicalItem(raw);
      if (!item) {
        throw new ProviderError(`Work item ${id} is not a tracked type after update`);
      }
      return item;
    } catch (err) {
      wrapError(err);
    }
  }

  async setAssignee(id: string, assignee: string | null): Promise<Item> {
    // System.AssignedTo accepts an `IdentityRef`-shaped value or a bare
    // identifier (email/UPN/display name). On an existing work item, "Add"
    // upserts the field; clearing requires the explicit "Remove" op (a
    // blank-string "Add" gets rejected by the server as an invalid value).
    const patch: JsonPatchOperation[] = assignee
      ? [
          {
            op: Operation.Add,
            path: "/fields/System.AssignedTo",
            value: assignee,
          },
        ]
      : [
          {
            op: Operation.Remove,
            path: "/fields/System.AssignedTo",
          },
        ];
    const wit = await this.witApi();
    try {
      const raw = await wit.updateWorkItem(null, patch, Number.parseInt(id, 10));
      const item = this.toCanonicalItem(raw);
      if (!item) {
        throw new ProviderError(`Work item ${id} is not a tracked type after update`);
      }
      return item;
    } catch (err) {
      wrapError(err);
    }
  }

  async createItem(kind: ItemKind, fields: CreateFields): Promise<Item> {
    const witType = WIT_BY_KIND[kind];
    if (!witType) {
      throw new ProviderError(`unsupported kind for create: ${kind}`);
    }
    const patch: JsonPatchOperation[] = [
      { op: Operation.Add, path: "/fields/System.Title", value: fields.title },
    ];
    if (fields.description) {
      patch.push({
        op: Operation.Add,
        path: "/fields/System.Description",
        value: fields.description,
      });
    }
    if (fields.assignee) {
      patch.push({
        op: Operation.Add,
        path: "/fields/System.AssignedTo",
        value: fields.assignee,
      });
    }
    if (fields.tags.length > 0) {
      patch.push({
        op: Operation.Add,
        path: "/fields/System.Tags",
        value: fields.tags.join("; "),
      });
    }
    if (fields.parentId) {
      patch.push({
        op: Operation.Add,
        path: "/relations/-",
        value: {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: `${this.config.orgUrl}/_apis/wit/workItems/${fields.parentId}`,
          attributes: {},
        },
      });
    }
    const wit = await this.witApi();
    try {
      const raw = await wit.createWorkItem(null, patch, this.config.project, witType);
      const item = this.toCanonicalItem(raw);
      if (!item) {
        throw new ProviderError("Created work item is not a tracked type");
      }
      return item;
    } catch (err) {
      wrapError(err);
    }
  }
}

function escapeWiql(value: string): string {
  return value.replaceAll("'", "''");
}
