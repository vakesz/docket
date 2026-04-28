import { handlers } from "@/server/auth";

// NextAuth pulls config + tokens from the DB and the encrypted-secrets layer
// — neither work on Edge, and per-request session cookies make caching wrong.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const { GET, POST } = handlers;
