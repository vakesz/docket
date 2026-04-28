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
import { z } from "zod";
import {
  archiveConversation,
  createConversation,
  getConversation,
  listConversations,
  ownsConversation,
} from "@/server/conversations/storage";
import { logger } from "@/server/logger";
import {
  projectIdSchema,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  router,
  userIdOrThrow,
} from "@/server/trpc";

const ConversationRef = projectIdSchema.extend({ conversationId: z.string().min(1) });

const ListInput = projectIdSchema.extend({
  itemId: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(100).default(50),
  archived: z.boolean().default(false),
});

const CreateInput = projectIdSchema.extend({
  itemId: z.string().nullable().default(null),
});

const SetLlmOverrideInput = ConversationRef.extend({
  llmProviderId: z.string().min(1).nullable(),
});

async function ensureOwn(
  ctx: {
    db: typeof import("@/server/db").db;
    session: { user: { id?: string } };
  },
  conversationId: string,
  projectId: string,
): Promise<void> {
  const userId = userIdOrThrow(ctx);
  const ok = await ownsConversation(ctx.db, conversationId, projectId, userId);
  if (!ok) {
    throw new TRPCError({ code: "NOT_FOUND", message: "conversation not found" });
  }
}

export const conversationsRouter = router({
  list: projectScopedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    return listConversations(ctx.db, {
      projectId: ctx.projectId,
      userId: userIdOrThrow(ctx),
      itemId: input.itemId,
      limit: input.limit,
      archived: input.archived,
    });
  }),

  get: projectScopedProcedure.input(ConversationRef).query(async ({ ctx, input }) => {
    await ensureOwn(ctx, input.conversationId, ctx.projectId);
    const conv = await getConversation(ctx.db, input.conversationId);
    if (!conv) {
      throw new TRPCError({ code: "NOT_FOUND", message: "conversation not found" });
    }
    return conv;
  }),

  create: projectScopedMutationProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    const userId = userIdOrThrow(ctx);
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
        const provider = await ctx.db.llmProvider.findUnique({
          where: { id: input.llmProviderId },
          select: { id: true, enabled: true },
        });
        if (!provider) {
          throw new TRPCError({ code: "NOT_FOUND", message: "LLM provider not found" });
        }
        if (!provider.enabled) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "LLM provider is disabled",
          });
        }
      }
      return ctx.db.conversation.update({
        where: { id: input.conversationId },
        data: { llmProviderIdOverride: input.llmProviderId },
        select: { id: true, llmProviderIdOverride: true },
      });
    }),
});
