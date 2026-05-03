/**
 * MCP OAuth redirect handler.
 *
 * The IdP redirects the user here with `?code=...&state=<nonce>` after
 * a successful consent. We pull the matching `McpOauthState` row,
 * complete the token exchange, and redirect to the project's settings
 * MCP pane. Errors are surfaced as a `?mcpOauth=error&message=...`
 * query so the UI can render an inline alert without the user losing
 * their place in settings.
 */

import { NextResponse } from "next/server";
import type { UserId } from "@/core/types";
import { db } from "@/db";
import { auth } from "@/server/auth";
import { logger } from "@/server/logger";
import { completeMcpOauth } from "@/server/mcp/oauth/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cap on the human-readable `message` value passed back to the settings UI.
// IdPs can return arbitrarily long `error_description` blurbs (some embed a
// stack trace or a full request id chain); copying that verbatim into the
// redirect makes the URL grow past common 4–8 KB header limits and surfaces
// as a useless "headers too large" error in the browser. The UI only needs
// enough text to render an inline alert.
const MESSAGE_MAX_BYTES = 512;

function trimMessage(raw: string): string {
  if (raw.length <= MESSAGE_MAX_BYTES) return raw;
  return `${raw.slice(0, MESSAGE_MAX_BYTES - 1)}…`;
}

function settingsRedirect(
  origin: string,
  projectSlug: string | null,
  params: Record<string, string>,
): NextResponse {
  const safeParams = { ...params };
  const rawMessage = safeParams["message"];
  if (typeof rawMessage === "string") {
    safeParams["message"] = trimMessage(rawMessage);
  }
  const search = new URLSearchParams(safeParams);
  const target = projectSlug
    ? `/settings?project=${encodeURIComponent(projectSlug)}&group=mcp&${search.toString()}`
    : `/?${search.toString()}`;
  // Anchor the redirect on the request's own origin — the callback URL we
  // registered with the IdP is built from this same origin, so it's the
  // single source of truth for "where is this app served from."
  return NextResponse.redirect(new URL(target, origin));
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const origin = url.origin;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");

  if (errorParam) {
    return settingsRedirect(origin, null, {
      mcpOauth: "error",
      message:
        url.searchParams.get("error_description") || `oauth provider returned: ${errorParam}`,
    });
  }
  if (!code || !state) {
    return settingsRedirect(origin, null, {
      mcpOauth: "error",
      message: "callback missing code or state",
    });
  }

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return settingsRedirect(origin, null, { mcpOauth: "error", message: "not authenticated" });
  }

  try {
    const { projectSlug, mcpServerId } = await completeMcpOauth({
      db,
      sessionUserId: userId as UserId,
      nonce: state,
      code,
    });
    return settingsRedirect(origin, projectSlug, {
      mcpOauth: "ok",
      serverId: mcpServerId,
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "mcp.oauth: callback failed",
    );
    return settingsRedirect(origin, null, {
      mcpOauth: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
