import { TRPCError } from "@trpc/server";
import { notFound } from "next/navigation";
import { db } from "@/server/db";
import { loadGlobalSetting } from "@/server/settings/effective";
import { createCaller } from "@/server/trpc-caller";
import { DetailPane } from "@/ui/items/detail-pane";

export default async function ItemDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; itemId: string }>;
}) {
  const { projectId, itemId } = await params;
  const trpc = await createCaller();

  let item: Awaited<ReturnType<typeof trpc.items.get>>;
  let project: Awaited<ReturnType<typeof trpc.projects.get>>;
  try {
    [item, project] = await Promise.all([
      trpc.items.get({ projectId, itemId }),
      trpc.projects.get({ projectId }),
    ]);
  } catch (err) {
    if (err instanceof TRPCError && (err.code === "FORBIDDEN" || err.code === "NOT_FOUND")) {
      notFound();
    }
    throw err;
  }

  const staleThresholdDays = await loadGlobalSetting(db, "items.stale-after-days");

  return (
    <DetailPane
      projectId={projectId}
      providerKind={project.providerKind}
      item={item}
      staleThresholdDays={staleThresholdDays > 0 ? staleThresholdDays : null}
    />
  );
}
