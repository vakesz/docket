import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";

import { ChatPane } from "~/components/chat/ChatPane";
import { ItemsList } from "~/components/items/ItemsList";
import { ThreePaneLayout } from "~/components/shell/ThreePaneLayout";

export const Route = createFileRoute("/items")({
  component: ItemsShell,
});

function ItemsShell() {
  const { itemId: selectedId } = useParams({ strict: false });
  return (
    <ThreePaneLayout
      left={<ItemsList selectedId={selectedId} />}
      middle={
        <div className="h-full overflow-hidden">
          <Outlet />
        </div>
      }
      right={
        selectedId ? (
          <ChatPane itemId={selectedId} />
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-sm text-zinc-500">
            Select an item to start a chat thread.
          </div>
        )
      }
    />
  );
}
