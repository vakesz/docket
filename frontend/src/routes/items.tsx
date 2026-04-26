import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";

import { ChatPane } from "~/components/chat/ChatPane";
import { ChatPaneProvider, useChatPaneController } from "~/components/chat/ChatPaneContext";
import { ItemsList } from "~/components/items/ItemsList";
import { ItemsShellLayout } from "~/components/shell/ItemsShellLayout";
import { ViewBar } from "~/components/shell/ViewBar";

export const Route = createFileRoute("/items")({
  component: ItemsShell,
});

function ItemsShell() {
  return (
    <ChatPaneProvider>
      <ItemsShellInner />
    </ChatPaneProvider>
  );
}

function ItemsShellInner() {
  const { itemId: selectedId } = useParams({ strict: false });
  const { open } = useChatPaneController();

  // Chat without a selected item has no target; collapse the pane in that
  // case so the user gets a full-width detail rather than an empty chat shell.
  const showChat = open && Boolean(selectedId);

  const left = (
    <div className="flex h-full flex-col">
      <ViewBar />
      <div className="flex-1 overflow-hidden">
        <ItemsList selectedId={selectedId} />
      </div>
    </div>
  );
  const middle = (
    <div className="h-full overflow-hidden">
      <Outlet />
    </div>
  );
  const right = showChat && selectedId ? <ChatPane itemId={selectedId} /> : null;

  return <ItemsShellLayout left={left} middle={middle} right={right} />;
}
