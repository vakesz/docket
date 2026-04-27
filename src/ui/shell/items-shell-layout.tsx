"use client";

import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { SEPARATOR } from "@/lib/form-classes";
import { cn } from "@/lib/utils";

/**
 * The 3-pane workspace: backlog (left), detail (middle), chat (right).
 *
 * If `right` is null, the chat pane collapses entirely and the middle
 * pane expands to fill it. Each layout (2-pane vs 3-pane) persists its
 * own widths in localStorage via `useDefaultLayout`, keyed off `groupId`.
 */
export function ItemsShellLayout({
  left,
  middle,
  right,
  groupId = "docket.shell",
}: {
  left: React.ReactNode;
  middle: React.ReactNode;
  right: React.ReactNode | null;
  groupId?: string;
}) {
  const showRight = right !== null;
  const panelIds = showRight ? ["left", "middle", "right"] : ["left", "middle"];
  const storage = typeof window !== "undefined" ? window.localStorage : undefined;
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id: `${groupId}.${showRight ? "3pane" : "2pane"}`,
    panelIds,
    storage,
  });

  return (
    <Group
      orientation="horizontal"
      id={groupId}
      className="group flex-1 overflow-hidden"
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
    >
      <Panel id="left" defaultSize={showRight ? 22 : 28} minSize={14} className="overflow-hidden">
        {left}
      </Panel>
      <Separator className={cn("w-px", SEPARATOR)} />
      <Panel id="middle" defaultSize={showRight ? 48 : 72} minSize={30} className="overflow-hidden">
        {middle}
      </Panel>
      {showRight && (
        <>
          <Separator className={cn("w-px", SEPARATOR)} />
          <Panel id="right" defaultSize={30} minSize={18} className="overflow-hidden">
            {right}
          </Panel>
        </>
      )}
    </Group>
  );
}
