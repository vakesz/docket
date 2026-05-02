// Auth + project membership are checked manually here (route handlers
// can't compose tRPC middleware) — the access shape mirrors
// `projectScopedMutationProcedure`: session present, project owned or a
// membership row exists.

import { NextResponse } from "next/server";
import { selectAdapterFor } from "@/agent/llm/registry";
import type { LoopEvent } from "@/agent/loop";
import { runTurn } from "@/agent/loop";
import { asConversationId, asUserId } from "@/core/types";

import { auth } from "@/server/auth";
import { getConversationForOwner } from "@/server/conversations/storage";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { projectForUser } from "@/server/projects/access";
import { loadGlobalSetting } from "@/server/settings/effective";
import { getSetupStatus } from "@/server/setup/status";

export const runtime = "nodejs"; // Prisma + openai SDK both need node, not edge.
export const dynamic = "force-dynamic";
// Defensive against serverless platform default timeouts (Vercel = 15s) that
// would guillotine longer agent turns. Self-host Node ignores this.
export const maxDuration = 300;

/**
 * Hard ceiling on the JSON body the stream endpoint will accept. The browser
 * UI already caps the input box well below this; the limit is a backstop
 * against runaway bodies (mistakes, hostile clients) before we spend memory
 * parsing them. Set generously enough to cover pasted code blocks but not
 * full attachments — those should land via dedicated upload endpoints.
 */
const MAX_BODY_BYTES = 100 * 1024;

type RouteContext = {
  params: Promise<{ projectSlug: string; conversationId: string }>;
};

export async function POST(req: Request, context: RouteContext): Promise<Response> {
  // Setup-required gate: server components call `requireSetupComplete()` which
  // redirects, but a streaming POST is no place for an HTML redirect — surface
  // the same condition as a 503 so the client can show a normal error.
  const setup = await getSetupStatus(db);
  if (!setup.complete) {
    return NextResponse.json({ error: "setup not complete" }, { status: 503 });
  }

  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = asUserId(session.user.id);
  const { projectSlug, conversationId: rawConversationId } = await context.params;
  const conversationId = asConversationId(rawConversationId);

  // Project membership: shares `projectForUser` with the tRPC
  // `enforceProjectMembership` middleware so both surfaces use the same
  // access check. The read-only setting is independent of the access
  // checks, so load it in parallel — saves one round-trip on every turn.
  const [project, readOnly] = await Promise.all([
    projectForUser(db, projectSlug, userId),
    loadGlobalSetting(db, "app.read-only"),
  ]);
  if (!project) {
    return NextResponse.json({ error: "no access to this project" }, { status: 403 });
  }
  const projectId = project.id;

  // Single round-trip that combines the ownership check with the
  // `llmProviderIdOverride` read the adapter resolver needs below.
  const conv = await getConversationForOwner(db, conversationId, projectId, userId);
  if (!conv) {
    return NextResponse.json({ error: "conversation not found" }, { status: 404 });
  }

  // Trust the Content-Length header for the cheap reject; if it's missing or
  // lying, fall back to checking the consumed body length below.
  const declaredLength = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "request body too large" }, { status: 413 });
  }

  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch {
    return NextResponse.json({ error: "could not read request body" }, { status: 400 });
  }
  if (bodyText.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "request body too large" }, { status: 413 });
  }
  let body: { content?: unknown };
  try {
    body = JSON.parse(bodyText) as { content?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  // Resolve the LLM adapter for this project (override > project default >
  // global default). Errors here are configuration problems, not stream
  // failures — surface them as a normal HTTP error. The read-only flag
  // (loaded above in parallel with project access) rides along: when global
  // read-only is on, the agent registry strips mutating tools so the agent
  // can't stage proposals against a DB the tRPC mutation procedures already
  // refuse.
  let adapter: Awaited<ReturnType<typeof selectAdapterFor>>;
  try {
    adapter = await selectAdapterFor(db, {
      project: {
        id: project.id,
        defaultLlmProviderId: project.defaultLlmProviderId,
        defaultTemperature: project.defaultTemperature,
      },
      overrideId: conv.llmProviderIdOverride,
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
      // Tracks whether the underlying stream has been torn down (client
      // disconnect → `cancel`, or normal completion → `close`). Any further
      // `enqueue` / `close` would throw, so we gate both on this flag.
      let closed = false;
      const send = (event: LoopEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(formatSseEvent(event)));
        } catch {
          closed = true;
        }
      };
      // Eagerly tear down the controller on client disconnect so subsequent
      // `enqueue`s no-op immediately even before `runTurn` reaches its next
      // yield point. `runTurn` itself receives `req.signal` and should bail
      // at the next checkpoint; this ensures the consumer side stops here.
      const onAbort = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already torn down; nothing to do.
        }
      };
      req.signal.addEventListener("abort", onAbort, { once: true });
      let terminal: "done" | "error" | "aborted" = "aborted";
      let lastErrorMessage: string | undefined;
      try {
        for await (const event of runTurn({
          db,
          adapter,
          conversationId,
          userId,
          userMessage: content,
          readOnly,
          signal: req.signal,
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
        // AbortError from `req.signal` means the client closed the connection.
        // That's expected, not an error — skip the error event/log.
        if (req.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          terminal = "aborted";
        } else {
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
        }
      } finally {
        req.signal.removeEventListener("abort", onAbort);
        if (!closed) {
          try {
            controller.close();
          } catch {
            // Already closed by the consumer side; nothing to do.
          }
          closed = true;
        }
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
      // Disable nginx-style proxy buffering. Without this, intermediaries
      // hold the response until close, defeating the SSE delta UX entirely.
      "X-Accel-Buffering": "no",
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
