import { Group, Panel, Separator } from "react-resizable-panels";

import { cn } from "~/lib/cn";

const SEPARATOR =
  "group-data-[orientation=horizontal]:w-px group-data-[orientation=horizontal]:cursor-col-resize bg-zinc-200 hover:bg-accent transition-colors data-[resizing]:bg-accent dark:bg-zinc-800";

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
    <Group orientation="horizontal" id="docket.shell" className="group flex-1">
      <Panel id="left" defaultSize={22} minSize={14} className="overflow-hidden">
        {left}
      </Panel>
      <Separator className={cn("w-px", SEPARATOR)} />
      <Panel id="middle" defaultSize={48} minSize={30} className="overflow-hidden">
        {middle}
      </Panel>
      <Separator className={cn("w-px", SEPARATOR)} />
      <Panel id="right" defaultSize={30} minSize={18} className="overflow-hidden">
        {right}
      </Panel>
    </Group>
  );
}
