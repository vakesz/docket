"use client";

import { Group, Panel, Separator } from "react-resizable-panels";
import { SEPARATOR } from "@/lib/form-classes";
import { cn } from "@/lib/utils";

/**
 * The 3-pane workspace: backlog (left), detail (middle), chat (right).
 *
 * If `right` is null, the chat pane collapses entirely and the middle
 * pane expands to fill the available space. Sizes use the Panel
 * defaultSize fallbacks — persistence used to live here via
 * `useDefaultLayout` but its localStorage payload outlived the layout
 * shape and was producing nonsensical widths after any resize. Until we
 * have a versioning story, the defaults stay deterministic.
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

  return (
    <Group
      orientation="horizontal"
      id={`${groupId}.${showRight ? "3pane" : "2pane"}`}
      className="group flex-1 overflow-hidden"
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
