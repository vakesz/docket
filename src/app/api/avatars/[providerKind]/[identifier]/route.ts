/**
 * Avatar serving endpoint.
 *
 * GET /api/avatars/{providerKind}/{identifier}
 *
 * Returns cached image bytes for an item-list assignee or a logged-in user
 * out of the `Avatar` table (`src/server/avatars/service.ts`). On miss, the
 * service runs a public-only lazy fetch (GitHub today; AzDO assignee fetch
 * needs a per-user identity-API hop we haven't wired). Confirmed-missing
 * rows return 404 with a short cache so the UI's onError fallback to an
 * initial chip kicks in deterministically.
 *
 * Auth: protected route. The avatars themselves are not strictly secret,
 * but every UI surface that asks for them is already behind auth, so
 * gating the endpoint keeps us off open avatar-farm territory.
 */

import { NextResponse } from "next/server";
import { auth } from "@/server/auth";
import { serveAvatar } from "@/server/avatars/service";
import { db } from "@/server/db";
import { getProviderSpec } from "@/server/provider-registry";

export const runtime = "nodejs";
// Auth + DB lookup on every request; nothing static to prerender.
export const dynamic = "force-dynamic";

const HIT_CACHE_HEADER = "public, max-age=86400, stale-while-revalidate=2592000";
const MISS_CACHE_HEADER = "public, max-age=300";

type RouteContext = {
  params: Promise<{ providerKind: string; identifier: string }>;
};

export async function GET(req: Request, context: RouteContext): Promise<Response> {
  const session = await auth();
  if (!session?.user) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const { providerKind, identifier } = await context.params;
  if (!getProviderSpec(providerKind)) {
    return new NextResponse("unknown provider kind", { status: 404 });
  }
  // The route is shaped `/{kind}/{identifier}` so Next has already URL-
  // decoded the segment by the time it reaches us; defend against an empty
  // segment from a malformed client.
  if (!identifier || identifier.length > 256) {
    return new NextResponse("bad identifier", { status: 400 });
  }

  const result = await serveAvatar(db, { providerKind, identifier });
  if (result.kind === "missing") {
    return new NextResponse("avatar not available", {
      status: 404,
      headers: { "Cache-Control": MISS_CACHE_HEADER },
    });
  }

  const ifNoneMatch = req.headers.get("if-none-match");
  if (result.etag && ifNoneMatch === result.etag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: result.etag, "Cache-Control": HIT_CACHE_HEADER },
    });
  }

  const headers = new Headers({
    "Content-Type": result.contentType,
    "Cache-Control": HIT_CACHE_HEADER,
    "Last-Modified": result.fetchedAt.toUTCString(),
  });
  if (result.etag) headers.set("ETag", result.etag);

  return new NextResponse(new Uint8Array(result.bytes), {
    status: 200,
    headers,
  });
}
