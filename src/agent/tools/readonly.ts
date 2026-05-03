/**
 * Read-only tools — items, comments, and (when the project is GitHub) PRs,
 * commits, CI.
 *
 * PR / commit / CI tools route through the registry-backed provider for
 * the project so they stay provider-agnostic — Azure DevOps will satisfy
 * the same WorkItemProvider methods.
 */

import "server-only";
import { and, asc, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { z } from "zod";
import type { AgentTool, ToolContext, ToolFactory } from "@/agent/tools/types";
import { defineTool, fail, ok, withProvider } from "@/agent/tools/types";
import { ITEM_KINDS, type ItemState, type ProviderItemId } from "@/core/types";
import { escapeLike } from "@/db/like";
import { items } from "@/db/schema";

export const listItemsTool: ToolFactory = (ctx) =>
  defineTool({
    name: "list_items",
    description:
      "List cached items in the current project. Filters by state bucket and free-text search. Use this to find items by topic before drilling in with get_item.",
    schema: z.object({
      bucket: z
        .enum(["open", "closed", "all"])
        .default("open")
        .describe("'open' | 'closed' | 'all'"),
      kind: z.enum(ITEM_KINDS).optional().describe("ItemKind filter (epic|feature|story|task|bug)"),
      search: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    // Result is an array of `{item_id,kind,title,state,assignee,url}`.
    // The only field carrying foreign content is `title`; the rest are
    // server-generated ids / provider-controlled enum strings.
    guardrailScan: { mode: "fields", untrusted: ["[].title"] },
    handler: async (args) => {
      const openStates: ItemState[] = ["new", "active", "blocked", "needs_info"];
      const closedStates: ItemState[] = ["resolved", "closed"];
      const searchPattern = args.search ? `%${escapeLike(args.search)}%` : null;
      const searchClause = searchPattern
        ? or(ilike(items.title, searchPattern), ilike(items.providerItemId, searchPattern))
        : undefined;
      const rows = await ctx.db
        .select({
          providerItemId: items.providerItemId,
          kind: items.kind,
          title: items.title,
          state: items.state,
          assignees: items.assignees,
          url: items.url,
        })
        .from(items)
        .where(
          and(
            eq(items.projectId, ctx.projectId),
            eq(items.archived, false),
            ...(args.kind ? [eq(items.kind, args.kind)] : []),
            ...(args.bucket === "open"
              ? [inArray(items.state, openStates)]
              : args.bucket === "closed"
                ? [inArray(items.state, closedStates)]
                : []),
            ...(searchClause ? [searchClause] : []),
          ),
        )
        .orderBy(desc(items.updatedAt))
        .limit(args.limit);
      return ok(
        rows.map((i) => ({
          item_id: i.providerItemId,
          kind: i.kind,
          title: i.title,
          state: i.state,
          assignee: i.assignees[0] ?? null,
          url: i.url,
        })),
      );
    },
  });

export const getItemTool: ToolFactory = (ctx) =>
  defineTool({
    name: "get_item",
    description:
      "Read the active item's cached description and recent comments. Defaults to the item this conversation is anchored on; pass `item_id` (e.g. 'owner/repo#42') only to read a different item. Returns title, description (markdown), state, assignee, comments (each with markdown body) — call this before drafting any propose_* on the active item so you're not echoing stale content.",
    schema: z.object({
      item_id: z
        .string()
        .min(1)
        .transform((v) => v as ProviderItemId)
        .optional(),
    }),
    // Foreign content lives in title, description, and each comment's body.
    // The surrounding ids/state/tags/url/timestamps are server-controlled
    // cache columns.
    guardrailScan: {
      mode: "fields",
      untrusted: ["title", "description", "comments[].body"],
    },
    handler: async (args) => {
      const itemId = args.item_id ?? ctx.providerItemId;
      if (!itemId) {
        return fail(
          "item_id is required when no item is anchored on this conversation; pass an explicit id like 'owner/repo#42'.",
        );
      }
      const item = await ctx.db.query.items.findFirst({
        where: and(eq(items.projectId, ctx.projectId), eq(items.providerItemId, itemId)),
        with: { comments: { orderBy: (c) => [asc(c.createdAt)] } },
      });
      if (!item) return fail(`Item '${itemId}' not in cache; the user may need to sync.`);
      return ok({
        item_id: item.providerItemId,
        kind: item.kind,
        title: item.title,
        state: item.state,
        assignee: item.assignees[0] ?? null,
        author: item.author,
        tags: [...item.tags],
        url: item.url,
        description: item.description,
        comments: item.comments.map((c) => ({
          author: c.author,
          body: c.body,
          created_at: c.createdAt,
        })),
      });
    },
  });

export const getPullRequestTool: ToolFactory = (ctx) =>
  defineTool({
    name: "get_pull_request",
    description:
      "Fetch live pull-request detail (title, body markdown, state, files, reviews) from the project's provider. The id format is provider-defined; pass exactly the string the project's provider uses (find_related_pull_requests / search_pull_requests return ids in that format).",
    schema: z.object({ pull_request_id: z.string().min(1) }),
    // Foreign content lives in title, body, and each review's body. Refs,
    // shas, label arrays, file paths are provider-controlled and shouldn't
    // be scanned for prompt injection.
    guardrailScan: { mode: "fields", untrusted: ["title", "body", "reviews[].body"] },
    handler: async ({ pull_request_id: pullRequestId }) => {
      try {
        return await withProvider(ctx, async (p) => {
          if (!p.getPullRequest) return fail("provider does not surface pull requests");
          const pr = await p.getPullRequest(pullRequestId);
          return ok({
            id: pr.id,
            url: pr.url,
            title: pr.title,
            number: pr.number,
            state: pr.state,
            author: pr.author,
            body: pr.body,
            head_ref: pr.headRef,
            base_ref: pr.baseRef,
            head_sha: pr.headSha,
            draft: pr.draft,
            merged: pr.merged,
            mergeable: pr.mergeable,
            labels: pr.labels,
            requested_reviewers: pr.requestedReviewers,
            additions: pr.additions,
            deletions: pr.deletions,
            changed_files: pr.changedFiles,
            files: pr.files,
            reviews: pr.reviews.map((r) => ({
              author: r.author,
              state: r.state,
              body: r.body,
              submitted_at: r.submittedAt,
            })),
            comments_count: pr.commentsCount,
            review_comments_count: pr.reviewCommentsCount,
            updated_at: pr.updatedAt,
          });
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

export const getCommitTool: ToolFactory = (ctx) =>
  defineTool({
    name: "get_commit",
    description: "Fetch live commit detail (sha, author, message, files) from the provider.",
    schema: z.object({ sha: z.string().min(1) }),
    // Commit message is the only field a contributor authors. Sha, file
    // paths, and counts are provider-generated identifiers.
    guardrailScan: { mode: "fields", untrusted: ["message"] },
    handler: async ({ sha }) => {
      try {
        return await withProvider(ctx, async (p) => {
          if (!p.getCommit) return fail("provider does not surface commits");
          const c = await p.getCommit(sha);
          return ok({
            sha: c.sha,
            url: c.url,
            author: c.author,
            author_email: c.authorEmail,
            committer: c.committer,
            committed_at: c.committedAt,
            message: c.message,
            parents: c.parents,
            additions: c.additions,
            deletions: c.deletions,
            files: c.files,
          });
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

export const getCIStatusTool: ToolFactory = (ctx) =>
  defineTool({
    name: "get_ci_status",
    description:
      "Fetch CI / check status for a ref (branch name, commit sha, or tag) from the provider.",
    schema: z.object({ ref: z.string().min(1) }),
    // Run name is the only field a repo author controls. Status / conclusion
    // are enum strings; ids and shas are provider identifiers.
    guardrailScan: { mode: "fields", untrusted: ["runs[].name"] },
    handler: async ({ ref }) => {
      try {
        return await withProvider(ctx, async (p) => {
          if (!p.getCIStatus) return fail("provider does not surface CI status");
          const status = await p.getCIStatus(ref);
          return ok({
            ref: status.ref,
            overall: status.overall,
            runs: status.runs.map((r) => ({
              id: r.id,
              name: r.name,
              status: r.status,
              conclusion: r.conclusion,
              url: r.url,
              head_sha: r.headSha,
              started_at: r.startedAt,
              completed_at: r.completedAt,
            })),
          });
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
