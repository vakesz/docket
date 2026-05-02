/**
 * Discovery tools — additional read-only surfaces for finding context.
 *
 * Pinned at the tail of `TOOL_ORDER` so introducing more discovery tools
 * later doesn't shift any earlier tool's prompt-cache slot. All four are
 * pure reads; they're available in read-only mode unchanged.
 */

import "server-only";
import { and, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { z } from "zod";
import type { AgentTool, ToolContext, ToolFactory } from "@/agent/tools/types";
import { defineTool, fail, ok, withProvider } from "@/agent/tools/types";
import { asProposalId, type ItemState } from "@/core/types";
import { audits, items as itemsTable } from "@/db/schema";

export const searchItemsTool: ToolFactory = (ctx) =>
  defineTool({
    name: "search_items",
    description:
      "Free-text search over cached items in this project. Matches case-insensitively against title and description body — wider than list_items's title/id-only search. Use this when the user describes the topic but not the item id.",
    schema: z.object({
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(50).default(20),
      bucket: z.enum(["open", "closed", "all"]).default("all"),
    }),
    // Returns `{query, count, items}`; only item titles carry foreign
    // content. The query echoes the agent's own argument back.
    guardrailScan: { mode: "fields", untrusted: ["items[].title"] },
    handler: async (args) => {
      const openStates: ItemState[] = ["new", "active", "blocked", "needs_info"];
      const closedStates: ItemState[] = ["resolved", "closed"];
      const pattern = `%${args.query}%`;
      const searchClause = or(
        ilike(itemsTable.title, pattern),
        ilike(itemsTable.description, pattern),
      );
      const rows = await ctx.db
        .select({
          providerItemId: itemsTable.providerItemId,
          kind: itemsTable.kind,
          title: itemsTable.title,
          state: itemsTable.state,
          assignees: itemsTable.assignees,
          url: itemsTable.url,
        })
        .from(itemsTable)
        .where(
          and(
            eq(itemsTable.projectId, ctx.projectId),
            eq(itemsTable.archived, false),
            ...(args.bucket === "open"
              ? [inArray(itemsTable.state, openStates)]
              : args.bucket === "closed"
                ? [inArray(itemsTable.state, closedStates)]
                : []),
            ...(searchClause ? [searchClause] : []),
          ),
        )
        .orderBy(desc(itemsTable.updatedAt))
        .limit(args.limit);
      return ok({
        query: args.query,
        count: rows.length,
        items: rows.map((i) => ({
          item_id: i.providerItemId,
          kind: i.kind,
          title: i.title,
          state: i.state,
          assignee: i.assignees[0] ?? null,
          url: i.url,
        })),
      });
    },
  });

export const listAuditLogTool: ToolFactory = (ctx) =>
  defineTool({
    name: "list_audit_log",
    description:
      "Read the project's append-only audit log of confirmed/rejected proposals. Use this to answer 'what was changed recently?' or to check whether a specific proposal kind has fired. Filter by `action` (e.g. 'proposal.confirm', 'proposal.reject', 'proposal.auto_confirm', 'proposal.confirm.failed') or by `proposal_id` for a single proposal's trail.",
    schema: z.object({
      action: z.string().min(1).max(64).optional(),
      proposal_id: z.string().min(1).transform(asProposalId).optional(),
      limit: z.number().int().min(1).max(100).default(25),
    }),
    // The audit envelope is server-controlled, but `payload` is a JSON blob
    // built by `confirmProposal` from the user's proposal contents — it can
    // contain comment markdown / description patches. Scan only that field.
    guardrailScan: { mode: "fields", untrusted: ["rows[].payload"] },
    handler: async (args) => {
      const rows = await ctx.db
        .select({
          id: audits.id,
          action: audits.action,
          proposalId: audits.proposalId,
          createdAt: audits.createdAt,
          payload: audits.payload,
        })
        .from(audits)
        .where(
          and(
            eq(audits.projectId, ctx.projectId),
            ...(args.action ? [eq(audits.action, args.action)] : []),
            ...(args.proposal_id ? [eq(audits.proposalId, args.proposal_id)] : []),
          ),
        )
        .orderBy(desc(audits.createdAt))
        .limit(args.limit);
      return ok({
        count: rows.length,
        rows: rows.map((r) => ({
          id: r.id,
          action: r.action,
          proposal_id: r.proposalId,
          created_at: r.createdAt,
          payload: r.payload,
        })),
      });
    },
  });

export const getPullRequestDiffTool: ToolFactory = (ctx) =>
  defineTool({
    name: "get_pull_request_diff",
    description:
      "Fetch the per-file unified diff for a pull request. Use this when reviewing a PR's content — get_pull_request gives metadata, this gives the actual code changes. The id format is provider-defined; pass exactly the string the project's provider uses (find_related_pull_requests / search_pull_requests return ids in that format).",
    schema: z.object({ pull_request_id: z.string().min(1) }),
    // The patch text is the foreign code payload. Paths and counts are
    // provider-controlled; the diff itself is the only injection surface.
    guardrailScan: { mode: "fields", untrusted: ["files[].patch"] },
    handler: async ({ pull_request_id: pullRequestId }) => {
      try {
        return await withProvider(ctx, async (p) => {
          if (!p.getPullRequestDiff) return fail("provider does not surface PR diffs");
          return ok(await p.getPullRequestDiff(pullRequestId));
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

export const searchPullRequestsTool: ToolFactory = (ctx) =>
  defineTool({
    name: "search_pull_requests",
    description:
      "Keyword search across the project's PR titles and bodies. Use this whenever `find_related_pull_requests` returned an empty `matches` array for an issue — it is the required fallback for finding PRs that were merged (or are open) without ever being linked to the issue. Pick distinctive nouns from the issue title; avoid boilerplate words like 'fix' or 'update'. Returns low-confidence matches (no explicit link signal) — verify any plausible hit by reading the PR with `get_pull_request` before acting.",
    schema: z.object({
      query: z.string().min(1).max(200),
      state: z.enum(["open", "closed", "merged", "all"]).default("all"),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    // PRMatch shape: `{url, title, branch, state, author, confidence}`.
    // Only the title is contributor-authored prose.
    guardrailScan: { mode: "fields", untrusted: ["matches[].title"] },
    handler: async (args) => {
      try {
        return await withProvider(ctx, async (p) => {
          if (!p.searchPullRequests) {
            return ok({
              matches: [] as const,
              note: "provider does not surface PR keyword search",
            });
          }
          const matches = await p.searchPullRequests(args.query, {
            state: args.state,
            limit: args.limit,
          });
          return ok({ matches });
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

export const searchCodeTool: ToolFactory = (ctx) =>
  defineTool({
    name: "search_code",
    description:
      "Search the project's repository for code matching `query`. Returns file paths and URLs only (no snippets). Use this to find call sites, definitions, or files mentioning a symbol when the user asks 'where is X used?', or to confirm a fix landed on a referenced symbol. Search syntax is provider-defined — most providers accept the bare symbol; some support scoping qualifiers (e.g. repo / path / language filters) when given an item's repositoryUrl. If a query returns nothing, try the bare symbol with no qualifiers before giving up.",
    schema: z.object({
      query: z.string().min(1).max(200),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    // CodeSearchResult is `{query, total, items: [{repository, path, url}]}`.
    // Every field is a provider-controlled identifier (no snippets, no
    // titles), so there's no foreign content for the guardrail to scan.
    guardrailScan: { mode: "skip" },
    handler: async (args) => {
      try {
        return await withProvider(ctx, async (p) => {
          if (!p.searchCode) return fail("provider does not surface code search");
          return ok(await p.searchCode(args.query, args.limit));
        });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    },
  });

export function discoveryTools(ctx: ToolContext): readonly AgentTool[] {
  return [
    searchItemsTool(ctx),
    listAuditLogTool(ctx),
    getPullRequestDiffTool(ctx),
    searchCodeTool(ctx),
    searchPullRequestsTool(ctx),
  ];
}
