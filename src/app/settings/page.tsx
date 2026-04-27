import { redirect } from "next/navigation";
import { auth } from "@/server/auth";
import { db } from "@/server/db";
import { requireSetupComplete } from "@/server/setup/guard";
import { SettingsShell } from "@/ui/settings/settings-shell";

/**
 * Unified settings page. One route, sidebar nav inside, no sub-routes.
 * The `?project=<id>` query param is the active project for the
 * project-scoped sections (Memory, Sources, MCP). When unset, fall back
 * to the user's default → most-recently-touched → none. The whole
 * topbar/footer chrome lives in `./layout.tsx`.
 */
const SECTION_KEYS = [
  "memory",
  "sources",
  "mcp",
  "project-llm",
  "project-analytics",
  "project-members",
  "project-export",
  "projects",
  "profile",
  "workspace",
  "budget-audit",
  "global-analytics",
  "llm-providers",
  "oauth-providers",
] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; section?: string }>;
}) {
  await requireSetupComplete();
  const session = await auth();
  if (!session?.user) {
    redirect("/");
  }

  const userId = session.user.id;
  const params = await searchParams;
  const requested = params.project ?? null;
  const requestedSection: SectionKey | undefined =
    params.section && (SECTION_KEYS as readonly string[]).includes(params.section)
      ? (params.section as SectionKey)
      : undefined;

  const me = await db.user.findUnique({
    where: { id: userId },
    select: { defaultProjectId: true },
  });

  const candidate =
    requested ??
    me?.defaultProjectId ??
    (
      await db.project.findFirst({
        where: {
          archivedAt: null,
          OR: [{ ownerUserId: userId }, { memberships: { some: { userId } } }],
        },
        orderBy: [{ updatedAt: "desc" }],
        select: { id: true },
      })
    )?.id ??
    null;

  // Validate access — a stale ?project= query param should fall back to
  // the default rather than blow up the page.
  const project = candidate
    ? await db.project.findFirst({
        where: {
          id: candidate,
          archivedAt: null,
          OR: [{ ownerUserId: userId }, { memberships: { some: { userId } } }],
        },
        select: { id: true, name: true },
      })
    : null;

  const publicBase = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").trim();

  return (
    <SettingsShell
      publicBase={publicBase}
      project={project ? { id: project.id, name: project.name } : null}
      initialSection={requestedSection}
    />
  );
}
