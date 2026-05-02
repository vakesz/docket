/**
 * Mutating tools — every one stages a proposal, none execute a write.
 *
 * The handlers route through `src/server/proposals/builders.ts`, the
 * same code path the tRPC `proposals.propose*` mutations use. The
 * agent's surface returns `{ proposalId, kind }` so the loop can stream
 * a "proposed: …" event to the chat UI; the actual provider write only
 * happens when a human clicks confirm in the diff dialog.
 *
 * AGENTS.md rule 5 (and the arch test `no-provider-write-leak`) keeps
 * this file from ever calling a `WorkItemProvider` write method.
 *
 * In read-only mode the tool registry strips this entire group — see
 * `src/agent/tools/registry.ts`. The handlers themselves don't gate
 * on role: by the time we get here the registry has already decided
 * whether to expose them.
 */

import "server-only";
import { z } from "zod";
import { zodToJsonSchema } from "@/agent/tools/schema";
import type { ToolFactory } from "@/agent/tools/types";
import { fail, ok } from "@/agent/tools/types";
import { ITEM_KINDS, TRANSITION_INTENTS } from "@/core/types";
import {
  proposeComment,
  proposeDescriptionPatch,
  proposeNewItem,
  proposeTagsChange,
  proposeTransition,
} from "@/server/proposals/builders";
import { maybeAutoAccept } from "@/server/proposals/executor";

const ItemKindEnum = z.enum(ITEM_KINDS);
const TransitionIntentEnum = z.enum(TRANSITION_INTENTS);

function builderCtx(ctx: Parameters<ToolFactory>[0]) {
  return {
    db: ctx.db,
    projectId: ctx.projectId,
    userId: ctx.userId,
    origin: "agent" as const,
  };
}

function resolveItemId(ctx: Parameters<ToolFactory>[0], arg: string | undefined): string | null {
  return arg ?? ctx.providerItemId;
}

// Every propose_* tool returns server-generated metadata only —
// `{ proposal_id, kind, status, auto_confirmed }`. There is no foreign
// content path, so the tool-result guardrail would just be flipping a
// coin on opaque JSON. Skip the scan entirely.
const PROPOSAL_SCAN = { mode: "skip" } as const;

function proposalResult(final: { id: string; kind: string; status: string }) {
  return {
    proposal_id: final.id,
    kind: final.kind,
    status: final.status,
    auto_confirmed: final.status === "confirmed",
  };
}

const TransitionArgsSchema = z.object({
  item_id: z.string().min(1).optional(),
  intent: TransitionIntentEnum,
  duplicate_of: z.string().min(1).optional(),
});

export const proposeTransitionTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_transition",
    description:
      "Stage a state transition on the active item. Pass the transition name in `intent` (one of: start_work | pause | block | needs_info | close_done | close_wontfix | close_duplicate | reopen). Defaults to the conversation's anchored item; pass `item_id` only to act on a different item. For `close_duplicate`, you MUST pass `duplicate_of` (the provider id of the canonical item this is a duplicate of) — pair it with a propose_comment that names the canonical item. `duplicate_of` is rejected for any other intent. Returns a proposal id — the human still confirms in the UI.",
    parameters: zodToJsonSchema(TransitionArgsSchema),
  },
  guardrailScan: PROPOSAL_SCAN,
  handler: async (raw) => {
    const args = TransitionArgsSchema.parse(raw);
    const itemId = resolveItemId(ctx, args.item_id);
    if (!itemId) {
      return fail("item_id is required when no item is anchored on this conversation.");
    }
    try {
      const row = await proposeTransition(builderCtx(ctx), {
        providerItemId: itemId,
        intent: args.intent,
        ...(args.duplicate_of ? { canonicalItemId: args.duplicate_of } : {}),
      });
      const final = await maybeAutoAccept(builderCtx(ctx), row);
      return ok(proposalResult(final));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const proposeDescriptionPatchTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_description_patch",
    description:
      "Stage a description patch on the active item. Pass ONLY the new top-level content in `new_description` (markdown) — do NOT include the old body or a 'Previous version' block; the system automatically appends the previous body with an author + date footer at the bottom for traceability (linear stack across patches). Defaults to the anchored item; pass `item_id` only to edit a different item. Read the current body with get_item first to understand what you're replacing.",
    parameters: zodToJsonSchema(
      z.object({
        item_id: z.string().min(1).optional(),
        new_description: z.string().min(1).max(50_000),
      }),
    ),
  },
  guardrailScan: PROPOSAL_SCAN,
  handler: async (raw) => {
    const args = z
      .object({
        item_id: z.string().min(1).optional(),
        new_description: z.string().min(1).max(50_000),
      })
      .parse(raw);
    const itemId = resolveItemId(ctx, args.item_id);
    if (!itemId) {
      return fail("item_id is required when no item is anchored on this conversation.");
    }
    try {
      const row = await proposeDescriptionPatch(builderCtx(ctx), {
        providerItemId: itemId,
        newDescription: args.new_description,
      });
      const final = await maybeAutoAccept(builderCtx(ctx), row);
      return ok(proposalResult(final));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const proposeCommentTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_comment",
    description:
      "Stage a comment on the active item. Pass the markdown text in `body`. Defaults to the anchored item; pass `item_id` only to comment on a different item. Comments should add information the description doesn't already contain — a status update, a question, a fix reference, a decision. Avoid restating the description.",
    parameters: zodToJsonSchema(
      z.object({
        item_id: z.string().min(1).optional(),
        body: z.string().min(1).max(50_000),
      }),
    ),
  },
  guardrailScan: PROPOSAL_SCAN,
  handler: async (raw) => {
    const args = z
      .object({
        item_id: z.string().min(1).optional(),
        body: z.string().min(1).max(50_000),
      })
      .parse(raw);
    const itemId = resolveItemId(ctx, args.item_id);
    if (!itemId) {
      return fail("item_id is required when no item is anchored on this conversation.");
    }
    try {
      const row = await proposeComment(builderCtx(ctx), {
        providerItemId: itemId,
        body: args.body,
      });
      const final = await maybeAutoAccept(builderCtx(ctx), row);
      return ok(proposalResult(final));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const proposeNewItemTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_new_item",
    description:
      "Stage creation of a new item. Pass `kind` (epic | feature | story | task | bug) plus a flat set of fields: `title` (required), `description` (markdown), `parent_id`, `assignee`, `tags`. When splitting an existing item into smaller pieces, set `parent_id` to the current item's id so the provider wires the parent-child link natively (the binding is provider-defined — sub-issue, parent link, or equivalent). After the human confirms the children, re-engage and stage one propose_description_patch on the parent that adds a '## Split into' section listing the new children.",
    parameters: zodToJsonSchema(
      z.object({
        kind: ItemKindEnum,
        title: z.string().min(1).max(500),
        description: z.string().max(50_000).default(""),
        parent_id: z.string().nullable().default(null),
        assignee: z.string().nullable().default(null),
        tags: z.array(z.string()).default([]),
      }),
    ),
  },
  guardrailScan: PROPOSAL_SCAN,
  handler: async (raw) => {
    const args = z
      .object({
        kind: ItemKindEnum,
        title: z.string().min(1).max(500),
        description: z.string().max(50_000).default(""),
        parent_id: z.string().nullable().default(null),
        assignee: z.string().nullable().default(null),
        tags: z.array(z.string()).default([]),
      })
      .parse(raw);
    try {
      const row = await proposeNewItem(builderCtx(ctx), {
        itemKind: args.kind,
        fields: {
          title: args.title,
          description: args.description,
          parentId: args.parent_id,
          assignee: args.assignee,
          tags: args.tags,
        },
      });
      const final = await maybeAutoAccept(builderCtx(ctx), row);
      return ok(proposalResult(final));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const proposeItemTagsTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_item_tags",
    description:
      "Stage a rewrite of the active item's user-facing tag set. Pass `tags` as the FULL target set (not a delta) — the executor preserves state-encoding labels (`blocked`, `needs-info`, `wontfix`) on its own, so do NOT include them here; route those through propose_transition (intents `block` / `needs_info` / `close_wontfix`). Defaults to the anchored item; pass `item_id` only to retag a different item. Use this when the evidence is unambiguous (e.g. a triaged item ready for pickup → add `ready-for-work`; a story estimated → add `estimated:5`). Do NOT invent labels — only use ones the project already uses. Before calling this on a project you haven't worked in, check list_memory for a 'Label conventions' entry; if missing, sample several recent items via list_items + get_item to learn the actual vocabulary, then stage propose_memory_write to capture it so future runs don't repeat the work.",
    parameters: zodToJsonSchema(
      z.object({
        item_id: z.string().min(1).optional(),
        tags: z.array(z.string().min(1).max(80)).max(50),
      }),
    ),
  },
  guardrailScan: PROPOSAL_SCAN,
  handler: async (raw) => {
    const args = z
      .object({
        item_id: z.string().min(1).optional(),
        tags: z.array(z.string().min(1).max(80)).max(50),
      })
      .parse(raw);
    const itemId = resolveItemId(ctx, args.item_id);
    if (!itemId) {
      return fail("item_id is required when no item is anchored on this conversation.");
    }
    try {
      const row = await proposeTagsChange(builderCtx(ctx), {
        providerItemId: itemId,
        nextTags: args.tags,
      });
      const final = await maybeAutoAccept(builderCtx(ctx), row);
      return ok(proposalResult(final));
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export function mutatingTools(ctx: Parameters<ToolFactory>[0]) {
  return [
    proposeTransitionTool(ctx),
    proposeDescriptionPatchTool(ctx),
    proposeCommentTool(ctx),
    proposeNewItemTool(ctx),
    proposeItemTagsTool(ctx),
  ] as const;
}
