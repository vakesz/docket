import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";
import { createCaller } from "@/server/trpc-caller";

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
    <div className="flex flex-col gap-6">
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

      <section className="rounded-md border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
        <p className="font-medium text-zinc-700 dark:text-zinc-300">
          Items, sync, and chat land in later phases.
        </p>
        <p className="mt-2">
          Phase 3 wires the GitHub provider and sync. Phase 5 adds conversations and the watchlist.
          Phase 6 brings the agent loop.
        </p>
      </section>
    </div>
  );
}
