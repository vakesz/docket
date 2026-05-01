/**
 * Memory mutating tools — stage memory_write / memory_delete proposals.
 *
 * Same pattern as `mutating.ts` (provider writes): the agent never touches
 * the `memoryEntry` table directly. It builds a Proposal, the human sees a
 * diff in `<ProposalDialog>`, and only on confirm does
 * `confirmProposal` perform the upsert / delete.
 *
 * In read-only mode the tool registry strips this entire group. The handlers
 * themselves don't gate on role: by the time we get here the registry has
 * already decided whether to expose them. This is registry slot 7 in the
 * pinned order — separate from provider mutations (slot 6) so a future
 * "writes are allowed but provider is offline" mode could expose memory
 * writes without provider writes.
 */

import "server-only";
import { z } from "zod";
import { zodToJsonSchema } from "@/agent/tools/schema";
import type { ToolFactory } from "@/agent/tools/types";
import { fail, ok } from "@/agent/tools/types";
import { proposeMemoryDelete, proposeMemoryWrite } from "@/server/proposals/builders";
import { maybeAutoAccept } from "@/server/proposals/executor";

function builderCtx(ctx: Parameters<ToolFactory>[0]) {
  return {
    db: ctx.db,
    projectId: ctx.projectId,
    userId: ctx.userId,
    origin: "agent" as const,
  };
}

export const proposeMemoryWriteTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_memory_write",
    description:
      "Stage a project-memory entry (create or update). Pass `title` (short, narrowly-scoped headline — one topic per entry), `body` (markdown), and optional `tags`. If `memory_id` is null a new entry is staged; otherwise the named entry is overwritten. Stage at most ONE memory write per reply, and only when you've learned something non-obvious that the next conversation couldn't easily re-derive (a project-specific convention, a glossary term, a recurring decision, an ownership pointer, a label/state convention you just inferred). Keep entries narrowly-scoped: split unrelated findings into separate entries with their own titles rather than piling everything into one note. Before staging a NEW entry, call list_memory to see if an entry on the same topic already exists — if so, pass that entry's `memory_id` to update it in place instead of creating a duplicate. The human reviews the diff and confirms before anything lands.",
    parameters: zodToJsonSchema(
      z.object({
        memory_id: z.string().nullable().default(null),
        title: z.string().min(1).max(200),
        body: z.string().max(50_000).default(""),
        tags: z.array(z.string().min(1).max(64)).max(32).default([]),
      }),
    ),
  },
  // Returns server-generated proposal metadata only — no foreign content.
  guardrailScan: { mode: "skip" },
  handler: async (raw) => {
    const args = z
      .object({
        memory_id: z.string().nullable().default(null),
        title: z.string().min(1).max(200),
        body: z.string().max(50_000).default(""),
        tags: z.array(z.string().min(1).max(64)).max(32).default([]),
      })
      .parse(raw);
    try {
      const row = await proposeMemoryWrite(builderCtx(ctx), {
        memoryId: args.memory_id,
        title: args.title,
        body: args.body,
        tags: args.tags,
        source: "agent",
      });
      const final = await maybeAutoAccept(builderCtx(ctx), row);
      return ok({
        proposal_id: final.id,
        kind: final.kind,
        status: final.status,
        auto_confirmed: final.status === "confirmed",
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const proposeMemoryDeleteTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_memory_delete",
    description: "Stage deletion of a project-memory entry. The human confirms before delete.",
    parameters: zodToJsonSchema(z.object({ memory_id: z.string().min(1) })),
  },
  // Returns server-generated proposal metadata only — no foreign content.
  guardrailScan: { mode: "skip" },
  handler: async (raw) => {
    const { memory_id: memoryId } = z.object({ memory_id: z.string().min(1) }).parse(raw);
    try {
      const row = await proposeMemoryDelete(builderCtx(ctx), { memoryId });
      const final = await maybeAutoAccept(builderCtx(ctx), row);
      return ok({
        proposal_id: final.id,
        kind: final.kind,
        status: final.status,
        auto_confirmed: final.status === "confirmed",
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export function memoryMutatingTools(ctx: Parameters<ToolFactory>[0]) {
  return [proposeMemoryWriteTool(ctx), proposeMemoryDeleteTool(ctx)] as const;
}
