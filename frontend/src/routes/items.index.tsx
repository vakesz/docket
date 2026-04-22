import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/items/")({
  component: ItemsIndex,
});

function ItemsIndex() {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-sm text-fg-muted">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">
          No item selected
        </div>
        <div className="mt-1">Pick one from the list to see its details.</div>
      </div>
    </div>
  );
}
