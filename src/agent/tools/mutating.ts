/**
 * Mutating tools — every one stages a proposal, none execute a write.
 *
 * The handlers route through `src/server/proposals/builders.ts`, the
 * same code path the tRPC `proposals.propose*` mutations use. The
 * agent's surface returns `{ proposalId, kind }` so the loop can stream
 * a "proposed: …" event to the chat UI; the actual provider write only
 * happens when a human clicks confirm in the diff dialog.
 *
 * CLAUDE.md rule 5 (and the arch test `no-provider-write-leak`) keeps
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
  proposeTransition,
} from "@/server/proposals/builders";

const ItemKindEnum = z.enum(ITEM_KINDS);
const TransitionIntentEnum = z.enum(TRANSITION_INTENTS);

function builderCtx(ctx: Parameters<ToolFactory>[0]) {
  return { db: ctx.db, projectId: ctx.projectId, userId: ctx.userId };
}

export const proposeTransitionTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_transition",
    description:
      "Stage a state transition for an item (e.g. start_work, close_done, reopen). Returns a proposal id; the human reviews and confirms in the UI.",
    parameters: zodToJsonSchema(
      z.object({
        providerItemId: z.string().min(1),
        intent: TransitionIntentEnum,
      }),
    ),
  },
  handler: async (raw) => {
    const args = z
      .object({
        providerItemId: z.string().min(1),
        intent: TransitionIntentEnum,
      })
      .parse(raw);
    try {
      const row = await proposeTransition(builderCtx(ctx), args);
      return ok({ proposalId: row.id, kind: row.kind });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const proposeDescriptionPatchTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_description_patch",
    description:
      "Stage a full-text replacement of an item's description. Pass the new markdown body in `newMd`. Use get_item first to read the current body so you can preserve sections you don't intend to change.",
    parameters: zodToJsonSchema(
      z.object({
        providerItemId: z.string().min(1),
        newMd: z.string().min(1).max(50_000),
      }),
    ),
  },
  handler: async (raw) => {
    const args = z
      .object({
        providerItemId: z.string().min(1),
        newMd: z.string().min(1).max(50_000),
      })
      .parse(raw);
    try {
      const row = await proposeDescriptionPatch(builderCtx(ctx), args);
      return ok({ proposalId: row.id, kind: row.kind });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const proposeCommentTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_comment",
    description: "Stage a new comment on an item. The human confirms before the provider write.",
    parameters: zodToJsonSchema(
      z.object({
        providerItemId: z.string().min(1),
        bodyMd: z.string().min(1).max(50_000),
      }),
    ),
  },
  handler: async (raw) => {
    const args = z
      .object({
        providerItemId: z.string().min(1),
        bodyMd: z.string().min(1).max(50_000),
      })
      .parse(raw);
    try {
      const row = await proposeComment(builderCtx(ctx), args);
      return ok({ proposalId: row.id, kind: row.kind });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  },
});

export const proposeNewItemTool: ToolFactory = (ctx) => ({
  def: {
    name: "propose_new_item",
    description:
      "Stage creation of a new item (epic | feature | story | task | bug). Title is required; descriptionMd, parentId, assignee, tags optional.",
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
      return ok({ proposalId: row.id, kind: row.kind });
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
  ] as const;
}
