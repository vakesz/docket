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
  return { db: ctx.db, projectId: ctx.projectId, userId: ctx.userId };
}

function resolveProviderItemId(
  ctx: Parameters<ToolFactory>[0],
  arg: string | undefined,
): string | null {
  return arg ?? ctx.providerItemId;
}

export const proposeTransitionTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_transition",
    description:
      "Stage a state transition on the active item. Pass the transition name in `intent` (one of: start_work | pause | block | needs_info | close_done | close_wontfix | reopen). Defaults to the conversation's anchored item; pass providerItemId only to act on a different item. Returns a proposal id — the human still confirms in the UI.",
    parameters: zodToJsonSchema(
      z.object({
        providerItemId: z.string().min(1).optional(),
        intent: TransitionIntentEnum,
      }),
    ),
  },
  handler: async (raw) => {
    const args = z
      .object({
        providerItemId: z.string().min(1).optional(),
        intent: TransitionIntentEnum,
      })
      .parse(raw);
    const providerItemId = resolveProviderItemId(ctx, args.providerItemId);
    if (!providerItemId) {
      return fail("providerItemId is required when no item is anchored on this conversation.");
    }
    try {
      const row = await proposeTransition(builderCtx(ctx), {
        providerItemId,
        intent: args.intent,
      });
      const final = await maybeAutoAccept(builderCtx(ctx), row);
      return ok({
        proposalId: final.id,
        kind: final.kind,
        status: final.status,
        autoConfirmed: final.status === "confirmed",
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const proposeDescriptionPatchTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_description_patch",
    description:
      "Stage a full-text replacement of the active item's description (`newMd` is the entire new body, not a patch). Defaults to the anchored item; pass providerItemId only to edit a different item. Read the current body with get_item first so you preserve sections you don't intend to change.",
    parameters: zodToJsonSchema(
      z.object({
        providerItemId: z.string().min(1).optional(),
        newMd: z.string().min(1).max(50_000),
      }),
    ),
  },
  handler: async (raw) => {
    const args = z
      .object({
        providerItemId: z.string().min(1).optional(),
        newMd: z.string().min(1).max(50_000),
      })
      .parse(raw);
    const providerItemId = resolveProviderItemId(ctx, args.providerItemId);
    if (!providerItemId) {
      return fail("providerItemId is required when no item is anchored on this conversation.");
    }
    try {
      const row = await proposeDescriptionPatch(builderCtx(ctx), {
        providerItemId,
        newMd: args.newMd,
      });
      const final = await maybeAutoAccept(builderCtx(ctx), row);
      return ok({
        proposalId: final.id,
        kind: final.kind,
        status: final.status,
        autoConfirmed: final.status === "confirmed",
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const proposeCommentTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_comment",
    description:
      "Stage a comment on the active item. Pass the markdown text in `bodyMd` (not `comment`/`body`/`text`). Defaults to the anchored item; pass providerItemId only to comment on a different item. Comments should add information the description doesn't already contain — a status update, a question, a fix reference, a decision. Avoid restating the description.",
    parameters: zodToJsonSchema(
      z.object({
        providerItemId: z.string().min(1).optional(),
        bodyMd: z.string().min(1).max(50_000),
      }),
    ),
  },
  handler: async (raw) => {
    const args = z
      .object({
        providerItemId: z.string().min(1).optional(),
        bodyMd: z.string().min(1).max(50_000),
      })
      .parse(raw);
    const providerItemId = resolveProviderItemId(ctx, args.providerItemId);
    if (!providerItemId) {
      return fail("providerItemId is required when no item is anchored on this conversation.");
    }
    try {
      const row = await proposeComment(builderCtx(ctx), {
        providerItemId,
        bodyMd: args.bodyMd,
      });
      const final = await maybeAutoAccept(builderCtx(ctx), row);
      return ok({
        proposalId: final.id,
        kind: final.kind,
        status: final.status,
        autoConfirmed: final.status === "confirmed",
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const proposeNewItemTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_new_item",
    description:
      "Stage creation of a new item. Pass the kind in `itemKind` (one of: epic | feature | story | task | bug) and the rest under a nested `fields` object: `{ title, descriptionMd?, parentId?, assignee?, tags? }`. Only `title` is required.",
    parameters: zodToJsonSchema(
      z.object({
        itemKind: ItemKindEnum,
        fields: z.object({
          title: z.string().min(1).max(500),
          descriptionMd: z.string().max(50_000).default(""),
          parentId: z.string().nullable().default(null),
          assignee: z.string().nullable().default(null),
          tags: z.array(z.string()).default([]),
        }),
      }),
    ),
  },
  handler: async (raw) => {
    const args = z
      .object({
        itemKind: ItemKindEnum,
        fields: z.object({
          title: z.string().min(1).max(500),
          descriptionMd: z.string().max(50_000).default(""),
          parentId: z.string().nullable().default(null),
          assignee: z.string().nullable().default(null),
          tags: z.array(z.string()).default([]),
        }),
      })
      .parse(raw);
    try {
      const row = await proposeNewItem(builderCtx(ctx), args);
      const final = await maybeAutoAccept(builderCtx(ctx), row);
      return ok({
        proposalId: final.id,
        kind: final.kind,
        status: final.status,
        autoConfirmed: final.status === "confirmed",
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const proposeItemTagsTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_item_tags",
    description:
      "Stage a rewrite of the active item's user-facing tag set. Pass `nextTags` as the FULL target set (not a delta) — the executor preserves state-encoding labels (blocked / needs-info / wontfix) on its own. Defaults to the anchored item; pass providerItemId only to retag a different item. Before calling this on a project you haven't worked in, check list_memory for a 'Label conventions' entry — and if you have to derive the convention by sampling other items, offer to record it via propose_memory_write so future runs don't repeat the work.",
    parameters: zodToJsonSchema(
      z.object({
        providerItemId: z.string().min(1).optional(),
        nextTags: z.array(z.string().min(1).max(80)).max(50),
      }),
    ),
  },
  handler: async (raw) => {
    const args = z
      .object({
        providerItemId: z.string().min(1).optional(),
        nextTags: z.array(z.string().min(1).max(80)).max(50),
      })
      .parse(raw);
    const providerItemId = resolveProviderItemId(ctx, args.providerItemId);
    if (!providerItemId) {
      return fail("providerItemId is required when no item is anchored on this conversation.");
    }
    try {
      const row = await proposeTagsChange(builderCtx(ctx), {
        providerItemId,
        nextTags: args.nextTags,
      });
      const final = await maybeAutoAccept(builderCtx(ctx), row);
      return ok({
        proposalId: final.id,
        kind: final.kind,
        status: final.status,
        autoConfirmed: final.status === "confirmed",
      });
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
