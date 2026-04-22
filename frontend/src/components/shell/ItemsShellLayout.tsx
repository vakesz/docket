import type { ReactNode } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";

import { cn } from "~/lib/cn";

const SEPARATOR =
  "group-data-[orientation=horizontal]:w-px group-data-[orientation=horizontal]:cursor-col-resize bg-border hover:bg-accent transition-colors data-[resizing]:bg-accent";

/**
 * Single resizable shell that hosts the items list, item detail, and an
 * optional chat pane on the right.
 *
 * The right pane is mounted/unmounted based on `right`, but the surrounding
 * `<Group>` and the left/middle `<Panel>` instances stay stable across that
 * transition. That stability matters: when the user clicks "Talk to the
 * agent" inside the middle pane, swapping the entire Group out from under the
 * click target was suppressing the synthetic event in Safari (the button's
 * DOM ancestor was being detached mid-event). Keeping the Group identity
 * stable means the click finishes on a still-attached node.
 */
export function ItemsShellLayout({
  left,
  middle,
  right,
}: {
  left: ReactNode;
  middle: ReactNode;
  right: ReactNode | null;
}) {
  const showRight = right !== null;

  return (
    <Group orientation="horizontal" id="docket.shell" className="group flex-1">
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
