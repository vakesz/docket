// Page-level (not middleware) because Next 16 middleware runs on Edge,
// where the postgres-js driver doesn't work. The setup-required page
// itself must NOT call this guard, or the redirect bounces against itself.

import "server-only";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { getSetupStatus, type SetupStatus } from "@/server/setup/status";

export async function requireSetupComplete(): Promise<SetupStatus> {
  const status = await getSetupStatus(db);
  if (!status.complete) {
    redirect("/setup-required");
  }
  return status;
}
