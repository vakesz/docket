/**
 * Read-only tools — items, comments, and (when the project is GitHub) PRs,
 * commits, CI.
 *
 * PR / commit / CI tools route through the registry-backed provider for
 * the project so they stay provider-agnostic — Azure DevOps will satisfy
 * the same WorkItemProvider methods.
 */

import "server-only";
import { z } from "zod";
import { zodToJsonSchema } from "@/agent/tools/schema";
import type { AgentTool, ToolContext, ToolFactory } from "@/agent/tools/types";
import { fail, ok } from "@/agent/tools/types";
import { buildProviderForUser } from "@/server/providers/build";

async function withProvider<T>(
  ctx: ToolContext,
  fn: (provider: Awaited<ReturnType<typeof buildProviderForUser>>) => Promise<T>,
): Promise<T> {
  const project = await ctx.db.project.findUnique({ where: { id: ctx.projectId } });
  if (!project) throw new Error(`project ${ctx.projectId} not found`);
  const provider = await buildProviderForUser(ctx.db, project, ctx.userId);
  return fn(provider);
}

export const listItemsTool: ToolFactory = (ctx) => ({
  def: {
    name: "list_items",
    description:
      "List cached items in the current project. Filters by state bucket and free-text search. Use this to find items by topic before drilling in with get_item.",
    parameters: zodToJsonSchema(
      z.object({
        bucket: z
          .enum(["open", "closed", "all"])
          .default("open")
          .describe("'open' | 'closed' | 'all'"),
        kind: z.string().optional().describe("ItemKind filter (epic|feature|story|task|bug)"),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    ),
  },
  // Result is an array of `{providerItemId,kind,title,state,assignee,url}`.
  // The only field carrying foreign content is `title`; the rest are
  // server-generated ids / provider-controlled enum strings.
  guardrailScan: { mode: "fields", untrusted: ["[].title"] },
  handler: async (raw) => {
    const args = z
      .object({
        bucket: z.enum(["open", "closed", "all"]).default("open"),
        kind: z.string().optional(),
        search: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .parse(raw);
    const items = await ctx.db.item.findMany({
      where: {
        projectId: ctx.projectId,
        archived: false,
        ...(args.kind ? { kind: args.kind } : {}),
        ...(args.bucket === "open"
          ? { state: { in: ["new", "active", "blocked", "needs_info"] } }
          : args.bucket === "closed"
            ? { state: { in: ["resolved", "closed"] } }
            : {}),
        ...(args.search
          ? {
              OR: [
                { title: { contains: args.search, mode: "insensitive" } },
                { providerItemId: { contains: args.search, mode: "insensitive" } },
              ],
            }
          : {}),
      },
      orderBy: [{ updatedAt: "desc" }],
      take: args.limit,
      select: {
        providerItemId: true,
        kind: true,
        title: true,
        state: true,
        assignee: true,
        url: true,
      },
    });
    return ok(items);
  },
});

export const getItemTool: ToolFactory = (ctx) => ({
  def: {
    name: "get_item",
    description:
      "Read the active item's cached body and recent comments. Defaults to the item this conversation is anchored on; pass providerItemId (e.g. 'owner/repo#42') only to read a different item. Returns title, body, state, assignee, comments — call this before drafting any propose_* on the active item so you're not echoing stale content.",
    parameters: zodToJsonSchema(
      z.object({
        providerItemId: z.string().min(1).optional(),
      }),
    ),
  },
  // Foreign content lives in title, descriptionMd, and each comment's
  // bodyMd. The surrounding ids/state/tags/url/timestamps are server-
  // controlled cache columns.
  guardrailScan: {
    mode: "fields",
    untrusted: ["title", "descriptionMd", "comments[].bodyMd"],
  },
  handler: async (raw) => {
    const args = z.object({ providerItemId: z.string().min(1).optional() }).parse(raw);
    const providerItemId = args.providerItemId ?? ctx.providerItemId;
    if (!providerItemId) {
      return fail(
        "providerItemId is required when no item is anchored on this conversation; pass an explicit id like 'owner/repo#42'.",
      );
    }
    const item = await ctx.db.item.findFirst({
      where: { projectId: ctx.projectId, providerItemId },
      include: { comments: { orderBy: [{ createdAt: "asc" }] } },
    });
    if (!item) return fail(`Item '${providerItemId}' not in cache; the user may need to sync.`);
    return ok({
      providerItemId: item.providerItemId,
      kind: item.kind,
      title: item.title,
      state: item.state,
      assignee: item.assignee,
      author: item.author,
      tags: item.tags,
      url: item.url,
      descriptionMd: item.descriptionMd,
      comments: item.comments.map((c) => ({
        author: c.author,
        bodyMd: c.bodyMd,
        createdAt: c.createdAt,
      })),
    });
  },
});

export const getPullRequestTool: ToolFactory = (ctx) => ({
  def: {
    name: "get_pull_request",
    description:
      "Fetch live pull-request detail (title, body, state, files, reviews) from the project's provider. Provider-specific id format (e.g. 'owner/repo#123' on GitHub).",
    parameters: zodToJsonSchema(z.object({ pullRequestId: z.string().min(1) })),
  },
  // PullRequestDetail carries foreign content in title, bodyMd, and each
  // review's bodyMd. Refs, shas, label arrays, file paths are provider-
  // controlled and shouldn't be scanned for prompt injection.
  guardrailScan: {
    mode: "fields",
    untrusted: ["title", "bodyMd", "reviews[].bodyMd"],
  },
  handler: async (raw) => {
    const { pullRequestId } = z.object({ pullRequestId: z.string().min(1) }).parse(raw);
    try {
      return await withProvider(ctx, async (p) => {
        if (!p.getPullRequest) return fail("provider does not surface pull requests");
        return ok(await p.getPullRequest(pullRequestId));
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const getCommitTool: ToolFactory = (ctx) => ({
  def: {
    name: "get_commit",
    description: "Fetch live commit detail (sha, author, message, files) from the provider.",
    parameters: zodToJsonSchema(z.object({ sha: z.string().min(1) })),
  },
  // Commit message is the only field a contributor authors. Sha, file
  // paths, and counts are provider-generated identifiers.
  guardrailScan: { mode: "fields", untrusted: ["message"] },
  handler: async (raw) => {
    const { sha } = z.object({ sha: z.string().min(1) }).parse(raw);
    try {
      return await withProvider(ctx, async (p) => {
        if (!p.getCommit) return fail("provider does not surface commits");
        return ok(await p.getCommit(sha));
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const getCIStatusTool: ToolFactory = (ctx) => ({
  def: {
    name: "get_ci_status",
    description:
      "Fetch CI / check status for a ref (branch name, commit sha, or tag) from the provider.",
    parameters: zodToJsonSchema(z.object({ ref: z.string().min(1) })),
  },
  // Run name is the only field a repo author controls. Status / conclusion
  // are enum strings; ids and shas are provider identifiers.
  guardrailScan: { mode: "fields", untrusted: ["runs[].name"] },
  handler: async (raw) => {
    const { ref } = z.object({ ref: z.string().min(1) }).parse(raw);
    try {
      return await withProvider(ctx, async (p) => {
        if (!p.getCIStatus) return fail("provider does not surface CI status");
        return ok(await p.getCIStatus(ref));
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export function readonlyTools(ctx: ToolContext): readonly AgentTool[] {
  return [
    listItemsTool(ctx),
    getItemTool(ctx),
    getPullRequestTool(ctx),
    getCommitTool(ctx),
    getCIStatusTool(ctx),
  ];
}
