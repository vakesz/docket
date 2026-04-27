/**
 * SSE chat-streaming endpoint.
 *
 * POST /api/projects/{projectId}/conversations/{conversationId}/stream
 *   body: { content: string }
 *
 * Drives one round of the agent loop and streams `LoopEvent`s back as
 * Server-Sent Events. The route returns text/event-stream and never
 * blocks on the full assistant response — the browser sees text deltas,
 * tool calls, proposal hand-offs, and `ask_user_question` events as they
 * happen.
 *
 * Auth + project membership are checked manually here (this route can't
 * compose tRPC middleware), but the underlying access shape is identical
 * to `projectScopedMutationProcedure`: session present, project owned or
 * membership row exists.
 */

import { NextResponse } from "next/server";
import { selectAdapterFor } from "@/agent/llm/registry";
import type { LoopEvent } from "@/agent/loop";
import { runTurn } from "@/agent/loop";
import { auth } from "@/server/auth";
import { ownsConversation } from "@/server/conversations/storage";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { projectForUser } from "@/server/projects/access";

export const runtime = "nodejs"; // Prisma + openai SDK both need node, not edge.
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ projectId: string; conversationId: string }>;
};

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = session.user.id;
  const { projectId, conversationId } = await context.params;

  // Project membership: shares `projectForUser` with the tRPC
  // `enforceProjectMembership` middleware so both surfaces use the same
  // access check.
  const project = await projectForUser(db, projectId, userId);
  if (!project) {
    return NextResponse.json({ error: "no access to this project" }, { status: 403 });
  }

  if (!(await ownsConversation(db, conversationId, projectId, userId))) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  let body: { content?: unknown };
  try {
    body = (await req.json()) as { content?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  // Resolve the LLM adapter for this project (override > project default >
  // global default). Errors here are configuration problems, not stream
  // failures — surface them as a normal HTTP error.
  let adapter: Awaited<ReturnType<typeof selectAdapterFor>>;
  try {
    const conv = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { llmProviderIdOverride: true },
    });
    adapter = await selectAdapterFor(db, {
      project: {
        id: project.id,
        defaultLlmProviderId: project.defaultLlmProviderId,
        defaultTemperature: project.defaultTemperature,
      },
      overrideId: conv?.llmProviderIdOverride ?? null,
    });
  } catch (err) {
    logger.error(
      {
        projectId,
        conversationId,
        userId,
        err: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      "stream: LLM adapter resolution failed",
    );
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "LLM adapter unavailable" },
      { status: 500 },
    );
  }

  const streamStartedAt = Date.now();
  logger.info(
    {
      projectId,
      conversationId,
      userId,
      adapter: adapter.kind,
      contentLen: content.length,
    },
    "stream: open",
  );

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: LoopEvent) => {
        controller.enqueue(encoder.encode(formatSseEvent(event)));
      };
      let terminal: "done" | "error" | "aborted" = "aborted";
      let lastErrorMessage: string | undefined;
      try {
        for await (const event of runTurn({
          db,
          adapter,
          conversationId,
          userId,
          userMessage: content,
          readOnly: false,
        })) {
          send(event);
          if (event.kind === "done") {
            terminal = "done";
            break;
          }
          if (event.kind === "error") {
            terminal = "error";
            lastErrorMessage = event.message;
            break;
          }
        }
      } catch (err) {
        terminal = "error";
        lastErrorMessage = err instanceof Error ? err.message : String(err);
        logger.error(
          {
            projectId,
            conversationId,
            userId,
            durationMs: Date.now() - streamStartedAt,
            err: lastErrorMessage,
            stack: err instanceof Error ? err.stack : undefined,
          },
          "stream: runTurn threw",
        );
        send({ kind: "error", message: lastErrorMessage });
      } finally {
        controller.close();
        logger.info(
          {
            projectId,
            conversationId,
            userId,
            terminal,
            durationMs: Date.now() - streamStartedAt,
            ...(lastErrorMessage ? { errMessage: lastErrorMessage } : {}),
          },
          "stream: closed",
        );
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function formatSseEvent(event: LoopEvent): string {
  // SSE: optional event name, then one or more `data:` lines, blank line.
  // Newlines in data must be split into multiple `data:` lines.
  const json = JSON.stringify(event);
  const dataLines = json
    .split("\n")
    .map((line) => `data: ${line}`)
    .join("\n");
  return `event: ${event.kind}\n${dataLines}\n\n`;
}
