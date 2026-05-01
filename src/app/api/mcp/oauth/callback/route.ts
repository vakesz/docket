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
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { logger } from "@/server/logger";
import { completeMcpOauth } from "@/server/mcp/oauth/router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function settingsRedirect(
  origin: string,
  projectSlug: string | null,
  params: Record<string, string>,
): NextResponse {
  const search = new URLSearchParams(params);
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
      sessionUserId: userId,
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
