/**
 * Empty middle pane when no item is selected. Sync and saved-view
 * controls live in the surrounding shell (StatusFooter, BacklogPane);
 * this slot is just the placeholder.
 */
export default function ItemsLandingPage() {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground">
      <div>
        <div className="text-xs uppercase tracking-wide text-muted-foreground/70">
          No item selected
        </div>
        <div className="mt-1">Pick one from the list to see its details.</div>
      </div>
    </div>
  );
}
