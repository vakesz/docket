/**
 * Conversations API.
 *
 * Real assistant turns flow through the SSE streaming route; this router
 * handles transcript reads, conversation lifecycle, and the per-conversation
 * LLM override.
 *
 * Conversations are per-project and optionally hang off a single item
 * (`itemId`). The same `Message` rows hold both human and synthetic system
 * messages — the inbound-changes module uses this same channel to inject
 * "item updated by another user" notices into active conversations
 * (`src/server/inbound-changes/inject.ts`).
 *
 * Reads use `projectScopedProcedure`. Writes use `projectScopedMutationProcedure`
 * — `viewer` members can read transcripts but cannot post messages.
 */

import "server-only";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { ConversationId, ItemId, ProjectId, UserId } from "@/core/types";
import type { Db } from "@/db";
import { conversations, llmProviders, messages } from "@/db/schema";
import {
  archiveConversation,
  createConversation,
  listConversations,
  ownsConversation,
} from "@/server/conversations/storage";
import { logger } from "@/server/logger";
import {
  assertFound,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  projectSlugSchema,
  router,
} from "@/server/trpc";

const ConversationRef = projectSlugSchema.extend({
  conversationId: z
    .string()
    .min(1)
    .transform((v) => v as ConversationId),
});

const ListInput = projectSlugSchema.extend({
  itemId: z
    .string()
    .nullable()
    .default(null)
    .transform((v) => (v === null ? null : (v as ItemId))),
  limit: z.number().int().min(1).max(100).default(50),
  archived: z.boolean().default(false),
});

const CreateInput = projectSlugSchema.extend({
  itemId: z
    .string()
    .nullable()
    .default(null)
    .transform((v) => (v === null ? null : (v as ItemId))),
});

const SetLlmOverrideInput = ConversationRef.extend({
  llmProviderId: z.string().min(1).nullable(),
});

async function ensureOwn(
  ctx: {
    db: Db;
    userId: UserId;
  },
  conversationId: ConversationId,
  projectId: ProjectId,
): Promise<void> {
  const ok = await ownsConversation(ctx.db, conversationId, projectId, ctx.userId);
  if (!ok) {
    throw new TRPCError({ code: "NOT_FOUND", message: "conversation not found" });
  }
}

export const conversationsRouter = router({
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    return listConversations(ctx.db, {
      projectId: ctx.projectId,
      userId: ctx.userId,
      itemId: input.itemId,
      limit: input.limit,
      archived: input.archived,
    });
  }),

  get: projectScopedProcedure.input(ConversationRef).query(async ({ ctx, input }) => {
    // findFirst + scoped where collapses the ownership double-check into the
    // SQL filter, so we never serialize projectId/userId we'd only re-validate.
    // The narrow `columns` carries exactly what chat-pane reads — full Message
    // rows include tokensIn/tokensOut/createdAt/conversationId/compacted that
    // the UI never touches, and skipping them shrinks every transcript fetch.
    const conv = assertFound(
      await ctx.db.query.conversations.findFirst({
        where: and(
          eq(conversations.id, input.conversationId),
          eq(conversations.projectId, ctx.projectId),
          eq(conversations.userId, ctx.userId),
        ),
        columns: {
          id: true,
          tokensIn: true,
          tokensOut: true,
          costCents: true,
          llmProviderIdOverride: true,
        },
        with: {
          messages: {
            where: eq(messages.compacted, false),
            // Latest-N descending then reverse — same defense-in-depth cap as
            // `getConversation` storage helper, see LIVE_TRANSCRIPT_CAP. The
            // compaction service is what's *supposed* to keep this bounded;
            // the cap protects the UI from runaway conversations that slipped
            // past compaction.
            orderBy: [desc(messages.createdAt), desc(messages.id)],
            limit: 500,
            columns: {
              id: true,
              role: true,
              content: true,
              toolName: true,
              toolCallId: true,
              toolCallsJson: true,
            },
          },
        },
      }),
      "conversation not found",
    );
    return { ...conv, messages: conv.messages.slice().reverse() };
  }),

  create: projectScopedMutationProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
    const conv = await createConversation(ctx.db, {
      projectId: ctx.projectId,
      userId,
      itemId: input.itemId,
    });
    logger.info(
      { projectId: ctx.projectId, userId, itemId: input.itemId, conversationId: conv.id },
      "conversation: created",
    );
    return conv;
  }),

  archive: projectScopedMutationProcedure
    .input(ConversationRef)
    .mutation(async ({ ctx, input }) => {
      await ensureOwn(ctx, input.conversationId, ctx.projectId);
      return archiveConversation(ctx.db, input.conversationId);
    }),

  /**
   * Set or clear the per-conversation LLM override. `null` falls back to the
   * project default. The chat-pane LLM switcher writes here; the agent loop
   * reads it back via `selectAdapterFor`.
   */
  setLlmOverride: projectScopedMutationProcedure
    .input(SetLlmOverrideInput)
    .mutation(async ({ ctx, input }) => {
      await ensureOwn(ctx, input.conversationId, ctx.projectId);
      if (input.llmProviderId) {
        const provider = assertFound(
          await ctx.db.query.llmProviders.findFirst({
            where: eq(llmProviders.id, input.llmProviderId),
            columns: { id: true, enabled: true },
          }),
          "LLM provider not found",
        );
        if (!provider.enabled) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "LLM provider is disabled",
          });
        }
      }
      const [row] = await ctx.db
        .update(conversations)
        .set({ llmProviderIdOverride: input.llmProviderId })
        .where(eq(conversations.id, input.conversationId))
        .returning({
          id: conversations.id,
          llmProviderIdOverride: conversations.llmProviderIdOverride,
        });
      if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "conversation not found" });
      return row;
    }),
});
