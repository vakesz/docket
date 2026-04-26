/**
 * Conversations API (Phase 5).
 *
 * Phase 5 ships chat-shaped infrastructure with a STUB assistant: each user
 * message echoes back as an assistant message so the UI can be built end-to-
 * end. Phase 6 swaps the stub for the real LLM-driven agent loop without
 * touching this router's public shape.
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
   * Append a user message and (Phase 5 stub) an assistant echo. Returns the
   * fresh transcript so the client can swap state without a re-fetch.
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
      // Phase 6 replaces this stub with a streaming agent turn.
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
});

function stubReply(userMessage: string): string {
  const trimmed = userMessage.trim();
  const preview = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  return `(stub assistant — Phase 6 wires the real agent)\n\nYou said: ${preview}`;
}
