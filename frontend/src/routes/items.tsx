import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/items")({
  component: ItemsShell,
});

function ItemsShell() {
  return (
    <div className="flex h-screen items-center justify-center text-zinc-500">
      <div className="text-center">
        <div className="font-mono text-xs uppercase tracking-wider text-zinc-400">Docket</div>
        <div className="mt-2 text-sm">Three-pane shell lands in Phase 3.</div>
      </div>
    </div>
  );
}
