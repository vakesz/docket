import { and, desc, eq, exists, isNull, or } from "drizzle-orm";
import { redirect } from "next/navigation";
import { asUserId } from "@/core/types";
import { db } from "@/db";
import { projectMemberships, projects, users } from "@/db/schema";
import { publicBaseUrl } from "@/lib/public-base-url";
import { auth } from "@/server/auth";
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
  "project-web-fetch",
  "project-agent-behavior",
  "project-analytics",
  "project-members",
  "project-export",
  "project-items",
  "projects",
  "profile",
  "chat",
  "items-list",
  "item-detail",
  "budget-audit",
  "global-analytics",
  "llm-providers",
  "oauth-providers",
  "read-only-mode",
] as const;
type SectionKey = (typeof SECTION_KEYS)[number];

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; section?: string }>;
}) {
  // Setup gate and session check are independent — fan them out so the
  // page's first await batches both round-trips.
  const [, session] = await Promise.all([requireSetupComplete(), auth()]);
  if (!session?.user?.id) {
    redirect("/");
  }

  const userId = asUserId(session.user.id);
  const params = await searchParams;
  const requested = params.project ?? null;
  const requestedSection: SectionKey | undefined =
    params.section && (SECTION_KEYS as readonly string[]).includes(params.section)
      ? (params.section as SectionKey)
      : undefined;

  const accessClause = or(
    eq(projects.ownerUserId, userId),
    exists(
      db
        .select({ id: projectMemberships.id })
        .from(projectMemberships)
        .where(
          and(eq(projectMemberships.projectId, projects.id), eq(projectMemberships.userId, userId)),
        ),
    ),
  );

  // ?project=<slug> wins; fall back to the user's pinned default (id), then
  // to the most-recently-touched membership. The slug branch and the user
  // record are independent — race them in parallel so the common case
  // (?project= matches) doesn't pay for the user lookup we won't use.
  const [requestedProject, me] = await Promise.all([
    requested
      ? db.query.projects.findFirst({
          where: and(eq(projects.slug, requested), isNull(projects.archivedAt), accessClause),
          columns: { id: true, slug: true, name: true },
        })
      : Promise.resolve(undefined),
    db.query.users.findFirst({
      where: eq(users.id, userId),
      columns: { defaultProjectId: true },
    }),
  ]);

  const project =
    requestedProject ??
    (me?.defaultProjectId
      ? await db.query.projects.findFirst({
          where: and(
            eq(projects.id, me.defaultProjectId),
            isNull(projects.archivedAt),
            accessClause,
          ),
          columns: { id: true, slug: true, name: true },
        })
      : undefined) ??
    (await db.query.projects.findFirst({
      where: and(isNull(projects.archivedAt), accessClause),
      orderBy: [desc(projects.updatedAt)],
      columns: { id: true, slug: true, name: true },
    }));

  const publicBase = publicBaseUrl();

  return (
    <SettingsShell
      publicBase={publicBase}
      project={project ? { id: project.id, slug: project.slug, name: project.name } : null}
      {...(requestedSection !== undefined ? { initialSection: requestedSection } : {})}
    />
  );
}
