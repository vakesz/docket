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
import type { ToolFactory } from "@/agent/tools/types";
import { builderCtxFromTool, defineTool, runProposalAction } from "@/agent/tools/types";
import { proposeMemoryDelete, proposeMemoryWrite } from "@/server/proposals/builders";
import { maybeAutoAccept } from "@/server/proposals/executor";

export const proposeMemoryWriteTool: ToolFactory = (ctx) =>
  defineTool({
    name: "propose_memory_write",
    description:
      "Stage a project-memory entry (create or update). Pass `title` (short, narrowly-scoped headline — one topic per entry), `body` (markdown), and optional `tags`. If `memory_id` is null a new entry is staged; otherwise the named entry is overwritten. Stage at most ONE memory write per reply, and only when you've learned something non-obvious that the next conversation couldn't easily re-derive (a project-specific convention, a glossary term, a recurring decision, an ownership pointer, a label/state convention you just inferred). Keep entries narrowly-scoped: split unrelated findings into separate entries with their own titles rather than piling everything into one note. Before staging a NEW entry, call list_memory to see if an entry on the same topic already exists — if so, pass that entry's `memory_id` to update it in place instead of creating a duplicate. The human reviews the diff and confirms before anything lands.",
    schema: z.object({
      memory_id: z.string().nullable().default(null),
      title: z.string().min(1).max(200),
      body: z.string().max(50_000).default(""),
      tags: z.array(z.string().min(1).max(64)).max(32).default([]),
    }),
    // Returns server-generated proposal metadata only — no foreign content.
    guardrailScan: { mode: "skip" },
    handler: async (args) => {
      const c = builderCtxFromTool(ctx);
      return runProposalAction(async () => {
        const row = await proposeMemoryWrite(c, {
          memoryId: args.memory_id,
          title: args.title,
          body: args.body,
          tags: args.tags,
          source: "agent",
        });
        return maybeAutoAccept(c, row);
      });
    },
  });

export const proposeMemoryDeleteTool: ToolFactory = (ctx) =>
  defineTool({
    name: "propose_memory_delete",
    description: "Stage deletion of a project-memory entry. The human confirms before delete.",
    schema: z.object({ memory_id: z.string().min(1) }),
    // Returns server-generated proposal metadata only — no foreign content.
    guardrailScan: { mode: "skip" },
    handler: async ({ memory_id: memoryId }) => {
      const c = builderCtxFromTool(ctx);
      return runProposalAction(async () => {
        const row = await proposeMemoryDelete(c, { memoryId });
        return maybeAutoAccept(c, row);
      });
    },
  });
