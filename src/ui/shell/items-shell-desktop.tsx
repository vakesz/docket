"use client";

import { Group, Panel, Separator } from "react-resizable-panels";

const RESIZE_HANDLE_CLASS =
  "w-px bg-border transition-colors data-[resize-handle-state=hover]:bg-muted-foreground/70 data-[resize-handle-state=drag]:bg-primary";

// Desktop-only `lg+` 3-pane Group. Pulled into its own file so
// `react-resizable-panels` lands in a separate chunk via next/dynamic —
// settings / auth / setup routes never load it.
//
// `id` is namespaced by pane count so the resizable group remembers its
// sizes per layout (3-pane and 2-pane are distinct shapes).
const GROUP_ID = "docket.shell";

export function ItemsShellDesktop({
  left,
  middle,
  right,
  showRight,
}: {
  left: React.ReactNode;
  middle: React.ReactNode;
  right: React.ReactNode | null;
  showRight: boolean;
}) {
  return (
    <Group
      orientation="horizontal"
      id={`${GROUP_ID}.${showRight ? "3pane" : "2pane"}`}
      className="group flex-1 overflow-hidden"
    >
      <Panel id="left" defaultSize={showRight ? 22 : 28} minSize={14} className="overflow-hidden">
        {left}
      </Panel>
      <Separator className={RESIZE_HANDLE_CLASS} />
      <Panel id="middle" defaultSize={showRight ? 48 : 72} minSize={30} className="overflow-hidden">
        {middle}
      </Panel>
      {showRight && (
        <>
          <Separator className={RESIZE_HANDLE_CLASS} />
          <Panel id="right" defaultSize={30} minSize={18} className="overflow-hidden">
            {right}
          </Panel>
        </>
      )}
    </Group>
  );
}
