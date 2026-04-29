import { redirect } from "next/navigation";

/**
 * Bare project URL → backlog. Per-project memory, sources, and MCP fleet
 * live in `/settings?project=<id>` (under the "Project" group); the
 * project landing should drop the user into the workspace shell instead
 * of a hidden admin dashboard.
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectSlug: string }>;
}) {
  const { projectSlug } = await params;
  redirect(`/projects/${projectSlug}/items`);
}
