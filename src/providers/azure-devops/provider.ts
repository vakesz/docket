/**
 * Azure DevOps `WorkItemProvider` implementation.
 *
 * Constructed from `{ orgUrl, project, accessToken }`. The token is an
 * AAD bearer issued through OAuth (`azure_devops` NextAuth provider) — same
 * token shape Microsoft accepts on the `vssps`/`dev.azure.com` REST surface.
 *
 * Soft states (`blocked`, `needs_info`, `closed-as-wontfix`) ride along as
 * **tags** because the Agile template has no native states for them. The
 * state map (`state-map.ts`) owns that encoding; this class only ferries the
 * resulting `(state, tags)` tuple to/from the WIT REST API.
 *
 * Description / comment bodies are HTML on AzDO; we round-trip them as-is
 * (no HTML→Markdown converter yet — the field appears in detail panes
 * verbatim, callers prepared to render either get sane output).
 *
 * PR / commit / CI methods are intentionally absent — AzDO Boards items
 * don't carry the same git-host signals GitHub does, and the agent's PR
 * tools tolerate providers that don't implement them.
 */

import * as azdev from "azure-devops-node-api";
import type { JsonPatchOperation } from "azure-devops-node-api/interfaces/common/VSSInterfaces.js";
import {
  type Comment as AzdoComment,
  WorkItemErrorPolicy,
  WorkItemExpand,
} from "azure-devops-node-api/interfaces/WorkItemTrackingInterfaces.js";
import type { IWorkItemTrackingApi } from "azure-devops-node-api/WorkItemTrackingApi.js";
import type { WorkItemProvider } from "@/core/provider";
import { ProviderAuthError, ProviderError, ProviderUnreachableError } from "@/core/provider";
import type {
  ChangedItem,
  Comment,
  CreateFields,
  Item,
  ItemKind,
  TransitionIntent,
} from "@/core/types";
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

const DEFAULT_FIELDS = [
  "System.Id",
  "System.WorkItemType",
  "System.Title",
  "System.Description",
  "System.State",
  "System.AssignedTo",
  "System.Parent",
  "System.Tags",
  "System.ChangedDate",
  "System.CreatedDate",
  "System.CommentCount",
  "System.AreaPath",
  "System.IterationPath",
  "System.TeamProject",
  "System.NodeName",
  "Microsoft.VSTS.Common.ClosedDate",
] as const;

const MAX_BATCH_IDS = 200;

function readConfig(raw: Record<string, unknown>): Config {
  const orgUrl = typeof raw.orgUrl === "string" ? raw.orgUrl.trim() : "";
  const project = typeof raw.project === "string" ? raw.project : "";
  const accessToken = typeof raw.accessToken === "string" ? raw.accessToken : "";
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
  const status = (err as { statusCode?: number; status?: number } | null)?.statusCode ?? null;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 401 || status === 403) {
    throw new ProviderAuthError(`Azure DevOps auth rejected: ${message}`);
  }
  if (status !== null && status >= 500) {
    throw new ProviderUnreachableError(`Azure DevOps upstream error: ${message}`);
  }
  if (err instanceof Error && /fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(err.message)) {
    throw new ProviderUnreachableError(`Azure DevOps unreachable: ${message}`);
  }
  throw new ProviderError(message);
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
  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const unique = obj.uniqueName ?? obj.unique_name;
    if (typeof unique === "string" && unique) return unique;
    const display = obj.displayName ?? obj.display_name;
    if (typeof display === "string" && display) return display;
  }
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

type WorkItemPayload = {
  id?: number;
  fields?: Record<string, unknown>;
  url?: string;
  relations?: Array<{ rel?: string; url?: string }>;
};

export class AzureDevOpsProvider implements WorkItemProvider {
  private readonly config: Config;
  private readonly providerKey: string;
  private wit: IWorkItemTrackingApi | null = null;

  constructor(rawConfig: Record<string, unknown>) {
    this.config = readConfig(rawConfig);
    this.providerKey = `azure_devops:${this.config.orgUrl}/${this.config.project}`;
  }

  private async witApi(): Promise<IWorkItemTrackingApi> {
    if (!this.wit) {
      const handler = azdev.getBearerHandler(this.config.accessToken);
      const conn = new azdev.WebApi(this.config.orgUrl, handler);
      this.wit = await conn.getWorkItemTrackingApi();
    }
    return this.wit;
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
    const id = String(payload.id ?? fields["System.Id"] ?? "");
    if (!id) return null;
    const tags = parseTags(fields["System.Tags"]);
    const stateField = fields["System.State"];
    const stateString = typeof stateField === "string" ? stateField : "";
    const parentRaw = fields["System.Parent"];
    const parent =
      typeof parentRaw === "number"
        ? String(parentRaw)
        : typeof parentRaw === "string" && parentRaw
          ? parentRaw
          : null;
    const assignee = readAssignee(fields["System.AssignedTo"]);
    const linkedItemIds: string[] = [];
    for (const rel of payload.relations ?? []) {
      const relType = rel.rel ?? "";
      if (!relType.startsWith("System.LinkTypes.") && !relType.startsWith("Microsoft.VSTS")) {
        continue;
      }
      const url = rel.url ?? "";
      const tail = url.replace(/\/+$/, "").split("/").pop() ?? "";
      if (/^\d+$/.test(tail) && tail !== id) linkedItemIds.push(tail);
    }
    const iteration =
      typeof fields["System.IterationPath"] === "string"
        ? (fields["System.IterationPath"] as string)
        : null;
    const area =
      typeof fields["System.AreaPath"] === "string" ? (fields["System.AreaPath"] as string) : null;
    return {
      id,
      kind,
      title: typeof fields["System.Title"] === "string" ? (fields["System.Title"] as string) : "",
      descriptionMd:
        typeof fields["System.Description"] === "string"
          ? (fields["System.Description"] as string)
          : "",
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
      providerRaw: payload as unknown as Record<string, unknown>,
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
      const handler = azdev.getBearerHandler(this.config.accessToken);
      const conn = new azdev.WebApi(this.config.orgUrl, handler);
      const profile = await conn.getProfileApi();
      const me = await profile.getProfile("me");
      const email = (me as { emailAddress?: string }).emailAddress;
      if (typeof email === "string" && email) return email;
      const display = (me as { displayName?: string }).displayName;
      return typeof display === "string" && display ? display : null;
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
        const payload = raw as unknown as WorkItemPayload;
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
      const author =
        (c.createdBy?.uniqueName as string | undefined) || c.createdBy?.displayName || "unknown";
      const created = c.createdDate ?? new Date();
      const modified = (c as { modifiedDate?: Date }).modifiedDate ?? null;
      return {
        id: String(c.id ?? ""),
        itemId: id,
        author,
        bodyMd: c.text ?? "",
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
        [...DEFAULT_FIELDS],
        undefined,
        WorkItemExpand.All,
      );
      const item = this.toCanonicalItem(raw as unknown as WorkItemPayload);
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
    const relations = (raw as unknown as WorkItemPayload).relations ?? [];
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
        [...DEFAULT_FIELDS],
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
      const item = this.toCanonicalItem(r as unknown as WorkItemPayload);
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
      patch.push({ op: 0, path: "/fields/System.State", value: plan.state } as JsonPatchOperation);
    }
    patch.push({
      op: 0,
      path: "/fields/System.Tags",
      value: newTags.join("; "),
    } as JsonPatchOperation);
    const wit = await this.witApi();
    try {
      const raw = await wit.updateWorkItem(null, patch, Number.parseInt(id, 10));
      const item = this.toCanonicalItem(raw as unknown as WorkItemPayload);
      if (!item) {
        throw new ProviderError(`Work item ${id} is not a tracked type after update`);
      }
      return item;
    } catch (err) {
      wrapError(err);
    }
  }

  async patchDescription(id: string, newMd: string): Promise<Item> {
    const patch: JsonPatchOperation[] = [
      { op: 0, path: "/fields/System.Description", value: newMd } as JsonPatchOperation,
    ];
    const wit = await this.witApi();
    try {
      const raw = await wit.updateWorkItem(null, patch, Number.parseInt(id, 10));
      const item = this.toCanonicalItem(raw as unknown as WorkItemPayload);
      if (!item) {
        throw new ProviderError(`Work item ${id} is not a tracked type after update`);
      }
      return item;
    } catch (err) {
      wrapError(err);
    }
  }

  async uploadAttachment(
    _id: string,
    _filename: string,
    _content: Uint8Array,
    _contentType: string,
  ): Promise<string> {
    // AzDO attachment upload requires streaming a NodeJS.ReadableStream into
    // createAttachment (Buffer→Readable shim) plus a second updateWorkItem to
    // add the relation. Not yet implemented.
    throw new ProviderError("Azure DevOps attachment upload not implemented yet");
  }

  async addComment(id: string, bodyMd: string): Promise<Comment> {
    const wit = await this.witApi();
    try {
      const resp = await wit.addComment(
        { text: bodyMd },
        this.config.project,
        Number.parseInt(id, 10),
      );
      const created = resp.createdDate ?? new Date();
      const modified = (resp as { modifiedDate?: Date }).modifiedDate ?? null;
      return {
        id: String(resp.id ?? ""),
        itemId: id,
        author:
          (resp.createdBy?.uniqueName as string | undefined) ||
          resp.createdBy?.displayName ||
          "unknown",
        bodyMd: resp.text ?? bodyMd,
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
        op: 0,
        path: "/fields/System.Tags",
        value: out.join("; "),
      } as JsonPatchOperation,
    ];
    const wit = await this.witApi();
    try {
      const raw = await wit.updateWorkItem(null, patch, Number.parseInt(id, 10));
      const item = this.toCanonicalItem(raw as unknown as WorkItemPayload);
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
      { op: 0, path: "/fields/System.Title", value: fields.title } as JsonPatchOperation,
    ];
    if (fields.descriptionMd) {
      patch.push({
        op: 0,
        path: "/fields/System.Description",
        value: fields.descriptionMd,
      } as JsonPatchOperation);
    }
    if (fields.assignee) {
      patch.push({
        op: 0,
        path: "/fields/System.AssignedTo",
        value: fields.assignee,
      } as JsonPatchOperation);
    }
    if (fields.tags.length > 0) {
      patch.push({
        op: 0,
        path: "/fields/System.Tags",
        value: fields.tags.join("; "),
      } as JsonPatchOperation);
    }
    if (fields.parentId) {
      patch.push({
        op: 0,
        path: "/relations/-",
        value: {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: `${this.config.orgUrl}/_apis/wit/workItems/${fields.parentId}`,
          attributes: {},
        },
      } as JsonPatchOperation);
    }
    const wit = await this.witApi();
    try {
      const raw = await wit.createWorkItem(null, patch, this.config.project, witType);
      const item = this.toCanonicalItem(raw as unknown as WorkItemPayload);
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
