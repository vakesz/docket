// CLAUDE.md rule 5 (+ arch test `no-provider-write-leak`) keeps this file
// from ever calling a `WorkItemProvider` write method — handlers stage a
// proposal and return `{ proposal_id, kind, status }`. Read-only mode
// strips this entire group at registry build time, so handlers don't
// re-check the role.

import "server-only";
import { z } from "zod";
import type { ToolFactory } from "@/agent/tools/types";
import { builderCtxFromTool, defineTool, fail, runProposalAction } from "@/agent/tools/types";
import { ITEM_KINDS, TRANSITION_INTENTS } from "@/core/types";
import { providerItemIdSchema } from "@/lib/zod-ids";
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
const ItemIdSchema = providerItemIdSchema;

// Every propose_* tool returns server-generated metadata only —
// `{ proposal_id, kind, status, auto_confirmed }`. There is no foreign
// content path, so the tool-result guardrail would just be flipping a
// coin on opaque JSON. Skip the scan entirely.
const PROPOSAL_SCAN = { mode: "skip" } as const;

export const proposeTransitionTool: ToolFactory = (ctx) =>
  defineTool({
    name: "propose_transition",
    description:
      "Stage a state transition on the active item. Pass the transition name in `intent` (one of: start_work | pause | block | needs_info | close_done | close_wontfix | close_duplicate | reopen). Defaults to the conversation's anchored item; pass `item_id` only to act on a different item. For `close_duplicate`, you MUST pass `duplicate_of` (the provider id of the canonical item this is a duplicate of) — pair it with a propose_comment that names the canonical item. `duplicate_of` is rejected for any other intent. Returns a proposal id — the human still confirms in the UI.",
    schema: z.object({
      item_id: ItemIdSchema.optional(),
      intent: TransitionIntentEnum,
      duplicate_of: ItemIdSchema.optional(),
    }),
    guardrailScan: PROPOSAL_SCAN,
    handler: async (args) => {
      const itemId = args.item_id ?? ctx.providerItemId;
      if (!itemId) {
        return fail("item_id is required when no item is anchored on this conversation.");
      }
      const c = builderCtxFromTool(ctx);
      return runProposalAction(async () => {
        const row = await proposeTransition(c, {
          providerItemId: itemId,
          intent: args.intent,
          ...(args.duplicate_of ? { canonicalItemId: args.duplicate_of } : {}),
        });
        return maybeAutoAccept(c, row);
      });
    },
  });

export const proposeDescriptionPatchTool: ToolFactory = (ctx) =>
  defineTool({
    name: "propose_description_patch",
    description:
      "Stage a description patch on the active item. Pass ONLY the new top-level content in `new_description` (markdown) — do NOT include the old body or a 'Previous version' block; the system automatically appends the previous body with an author + date footer at the bottom for traceability (linear stack across patches). Defaults to the anchored item; pass `item_id` only to edit a different item. Read the current body with get_item first to understand what you're replacing.",
    schema: z.object({
      item_id: ItemIdSchema.optional(),
      new_description: z.string().min(1).max(50_000),
    }),
    guardrailScan: PROPOSAL_SCAN,
    handler: async (args) => {
      const itemId = args.item_id ?? ctx.providerItemId;
      if (!itemId) {
        return fail("item_id is required when no item is anchored on this conversation.");
      }
      const c = builderCtxFromTool(ctx);
      return runProposalAction(async () => {
        const row = await proposeDescriptionPatch(c, {
          providerItemId: itemId,
          newDescription: args.new_description,
        });
        return maybeAutoAccept(c, row);
      });
    },
  });

export const proposeCommentTool: ToolFactory = (ctx) =>
  defineTool({
    name: "propose_comment",
    description:
      "Stage a comment on the active item. Pass the markdown text in `body`. Defaults to the anchored item; pass `item_id` only to comment on a different item. Comments should add information the description doesn't already contain — a status update, a question, a fix reference, a decision. Avoid restating the description.",
    schema: z.object({
      item_id: ItemIdSchema.optional(),
      body: z.string().min(1).max(50_000),
    }),
    guardrailScan: PROPOSAL_SCAN,
    handler: async (args) => {
      const itemId = args.item_id ?? ctx.providerItemId;
      if (!itemId) {
        return fail("item_id is required when no item is anchored on this conversation.");
      }
      const c = builderCtxFromTool(ctx);
      return runProposalAction(async () => {
        const row = await proposeComment(c, { providerItemId: itemId, body: args.body });
        return maybeAutoAccept(c, row);
      });
    },
  });

export const proposeNewItemTool: ToolFactory = (ctx) =>
  defineTool({
    name: "propose_new_item",
    description:
      "Stage creation of a new item. Pass `kind` (epic | feature | story | task | bug) plus a flat set of fields: `title` (required), `description` (markdown), `parent_id`, `assignee`, `tags`. When splitting an existing item into smaller pieces, set `parent_id` to the current item's id so the provider wires the parent-child link natively (the binding is provider-defined — sub-issue, parent link, or equivalent). After the human confirms the children, re-engage and stage one propose_description_patch on the parent that adds a '## Split into' section listing the new children.",
    schema: z.object({
      kind: ItemKindEnum,
      title: z.string().min(1).max(500),
      description: z.string().max(50_000).default(""),
      parent_id: z.string().nullable().default(null),
      assignee: z.string().nullable().default(null),
      tags: z.array(z.string()).default([]),
    }),
    guardrailScan: PROPOSAL_SCAN,
    handler: async (args) => {
      const c = builderCtxFromTool(ctx);
      return runProposalAction(async () => {
        const row = await proposeNewItem(c, {
          itemKind: args.kind,
          fields: {
            title: args.title,
            description: args.description,
            parentId: args.parent_id,
            assignee: args.assignee,
            tags: args.tags,
          },
        });
        return maybeAutoAccept(c, row);
      });
    },
  });

export const proposeItemTagsTool: ToolFactory = (ctx) =>
  defineTool({
    name: "propose_item_tags",
    description:
      "Stage a rewrite of the active item's user-facing tag set. Pass `tags` as the FULL target set (not a delta) — the executor preserves state-encoding labels (`blocked`, `needs-info`, `wontfix`) on its own, so do NOT include them here; route those through propose_transition (intents `block` / `needs_info` / `close_wontfix`). Defaults to the anchored item; pass `item_id` only to retag a different item. Use this when the evidence is unambiguous (e.g. a triaged item ready for pickup → add `ready-for-work`; a story estimated → add `estimated:5`). Do NOT invent labels — only use ones the project already uses. Before calling this on a project you haven't worked in, check list_memory for a 'Label conventions' entry; if missing, sample several recent items via list_items + get_item to learn the actual vocabulary, then stage propose_memory_write to capture it so future runs don't repeat the work.",
    schema: z.object({
      item_id: ItemIdSchema.optional(),
      tags: z.array(z.string().min(1).max(80)).max(50),
    }),
    guardrailScan: PROPOSAL_SCAN,
    handler: async (args) => {
      const itemId = args.item_id ?? ctx.providerItemId;
      if (!itemId) {
        return fail("item_id is required when no item is anchored on this conversation.");
      }
      const c = builderCtxFromTool(ctx);
      return runProposalAction(async () => {
        const row = await proposeTagsChange(c, {
          providerItemId: itemId,
          nextTags: args.tags,
        });
        return maybeAutoAccept(c, row);
      });
    },
  });
