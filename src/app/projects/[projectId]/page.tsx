import { TRPCError } from "@trpc/server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { createCaller } from "@/server/trpc-caller";
import { McpPane } from "@/ui/mcp/mcp-pane";
import { MemoryPane } from "@/ui/memory/memory-pane";
import { SourcesPane } from "@/ui/sources/sources-pane";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const trpc = await createCaller();

  let project: Awaited<ReturnType<typeof trpc.projects.get>>;
  try {
    project = await trpc.projects.get({ projectId });
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) {
      notFound();
    }
    throw err;
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 overflow-y-auto px-6 py-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
        {project.description ? (
          <p className="text-sm text-zinc-500">{project.description}</p>
        ) : null}
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500">
          <span>provider:</span>
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
            {project.providerKind.replace("_", " ")}
          </span>
        </div>
      </div>

      <section className="flex flex-col gap-4 rounded-md border border-zinc-200 p-6 dark:border-zinc-800">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium">Surfaces</h2>
        </div>
        <ul className="flex flex-col gap-2 text-sm">
          <li>
            <Link
              href={`/projects/${projectId}/items`}
              className="rounded-md px-2 py-1 hover:bg-zinc-100 dark:hover:bg-zinc-900"
            >
              → Items (cached from the provider)
            </Link>
          </li>
        </ul>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <MemoryPane projectId={projectId} />
        <SourcesPane projectId={projectId} />
      </div>

      <McpPane projectId={projectId} />
    </div>
  );
}
