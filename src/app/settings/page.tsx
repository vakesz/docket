import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { requireSetupComplete } from "@/server/setup/guard";
import { SettingsShell } from "@/ui/settings/settings-shell";

/**
 * Unified settings page. One route, sidebar nav inside, no sub-routes —
 * mirrors main's `SettingsPage`. The "← back to project" link uses the
 * user's default (or most-recently-touched) project so closing settings
 * lands somewhere sensible instead of bouncing through `/`.
 */
export default async function SettingsPage() {
  await requireSetupComplete();
  const session = await auth();
  if (!session?.user) {
    redirect("/");
  }

  const userId = session.user.id;
  const me = await db.user.findUnique({
    where: { id: userId },
    select: { defaultProjectId: true },
  });

  const backProject = await db.project.findFirst({
    where: {
      archivedAt: null,
      id: me?.defaultProjectId ?? undefined,
      OR: [{ ownerUserId: userId }, { memberships: { some: { userId } } }],
    },
    select: { id: true, name: true },
  });
  const fallback = backProject
    ? null
    : await db.project.findFirst({
        where: {
          archivedAt: null,
          OR: [{ ownerUserId: userId }, { memberships: { some: { userId } } }],
        },
        orderBy: [{ updatedAt: "desc" }],
        select: { id: true, name: true },
      });
  const back = backProject ?? fallback;

  const publicBase = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").trim();

  return (
    <main className="flex min-h-screen flex-col bg-bg text-fg">
      <header className="flex items-baseline justify-between border-b border-border bg-surface px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
          <p className="text-sm text-fg-muted">
            Per-user preferences plus deployment-wide configuration.
          </p>
        </div>
        <Link
          href={back ? `/projects/${back.id}/items` : "/"}
          className="text-sm text-fg-muted hover:text-fg"
        >
          ← {back ? back.name : "Home"}
        </Link>
      </header>
      <div className="flex flex-1 overflow-hidden">
        <SettingsShell publicBase={publicBase} />
      </div>
    </main>
  );
}
