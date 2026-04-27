/**
 * Conversations API.
 *
 * `postMessage` currently appends a stub assistant echo so the UI can be
 * exercised end-to-end; the streaming SSE route drives real agent turns.
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
  compactConversation,
  getDecision,
  loadCompactionSettings,
} from "@/server/conversations/compaction";
import {
  appendMessage,
  archiveConversation,
  createConversation,
  getConversation,
  listConversations,
  ownsConversation,
} from "@/server/conversations/storage";
import { projectScopedMutationProcedure, projectScopedProcedure, router } from "@/server/trpc";

const ProjectId = z.object({ projectId: z.string().min(1) });
const ConversationRef = ProjectId.extend({ conversationId: z.string().min(1) });

const ListInput = ProjectId.extend({
  itemId: z.string().nullable().default(null),
  limit: z.number().int().min(1).max(100).default(50),
  archived: z.boolean().default(false),
});

const CreateInput = ProjectId.extend({
  itemId: z.string().nullable().default(null),
});

const PostMessageInput = ConversationRef.extend({
  content: z.string().min(1).max(20_000),
});

const SetLlmOverrideInput = ConversationRef.extend({
  llmProviderId: z.string().min(1).nullable(),
});

function userIdOrThrow(ctx: { session: { user: { id?: string } } }): string {
  const userId = ctx.session.user.id;
  if (!userId) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return userId;
}

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
    return createConversation(ctx.db, {
      projectId: ctx.projectId,
      userId,
      itemId: input.itemId,
    });
  }),

  /**
   * Append a user message and a stub assistant echo. Returns the fresh
   * transcript so the client can swap state without a re-fetch. Real
   * agent turns flow through the SSE streaming route.
   */
  postMessage: projectScopedMutationProcedure
    .input(PostMessageInput)
    .mutation(async ({ ctx, input }) => {
      await ensureOwn(ctx, input.conversationId, ctx.projectId);
      await appendMessage(ctx.db, {
        conversationId: input.conversationId,
        role: "user",
        content: input.content,
      });
      await appendMessage(ctx.db, {
        conversationId: input.conversationId,
        role: "assistant",
        content: stubReply(input.content),
      });
      const conv = await getConversation(ctx.db, input.conversationId);
      if (!conv) {
        throw new TRPCError({ code: "NOT_FOUND", message: "conversation vanished" });
      }
      return conv;
    }),

  archive: projectScopedMutationProcedure
    .input(ConversationRef)
    .mutation(async ({ ctx, input }) => {
      await ensureOwn(ctx, input.conversationId, ctx.projectId);
      return archiveConversation(ctx.db, input.conversationId);
    }),

  /**
   * Compaction status for the chat-pane "near threshold" badge. Cheap query
   * — token count is a char-based heuristic, no LLM call.
   */
  compactionStatus: projectScopedProcedure.input(ConversationRef).query(async ({ ctx, input }) => {
    await ensureOwn(ctx, input.conversationId, ctx.projectId);
    return getDecision(ctx.db, ctx.projectId, input.conversationId);
  }),

  /**
   * Manual compaction trigger. Always available regardless of the
   * `llm.compaction.enabled` toggle so users can trim a runaway thread on
   * demand. Strategy + keep-recent-turns still come from project settings.
   */
  compact: projectScopedMutationProcedure
    .input(ConversationRef)
    .mutation(async ({ ctx, input }) => {
      await ensureOwn(ctx, input.conversationId, ctx.projectId);
      const settings = await loadCompactionSettings(ctx.db, ctx.projectId);
      // For manual compaction, force the threshold to 0 so the call always
      // runs; auto-compaction in the loop respects the configured value.
      const result = await compactConversation(ctx.db, input.conversationId, {
        ...settings,
        tokenThreshold: 0,
      });
      return result;
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

function stubReply(userMessage: string): string {
  const trimmed = userMessage.trim();
  const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  return `(stub assistant — use the streaming endpoint for real agent turns)\n\nYou said: ${preview}`;
}
