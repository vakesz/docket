import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { cn } from "~/lib/cn";

const HANDLE_BASE =
  "w-px bg-zinc-200 hover:bg-accent transition-colors data-[resize-handle-state=drag]:bg-accent dark:bg-zinc-800";

export function ThreePaneLayout({
  left,
  middle,
  right,
}: {
  left: React.ReactNode;
  middle: React.ReactNode;
  right: React.ReactNode;
}) {
  return (
    <PanelGroup direction="horizontal" autoSaveId="docket.shell" className="flex-1">
      <Panel defaultSize={22} minSize={14} className="overflow-hidden">
        {left}
      </Panel>
      <PanelResizeHandle className={cn(HANDLE_BASE)} />
      <Panel defaultSize={48} minSize={30} className="overflow-hidden">
        {middle}
      </Panel>
      <PanelResizeHandle className={cn(HANDLE_BASE)} />
      <Panel defaultSize={30} minSize={18} className="overflow-hidden">
        {right}
      </Panel>
    </PanelGroup>
  );
}
