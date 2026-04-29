import { Skeleton } from "@/ui/primitives/skeleton";

/**
 * Shown while the items layout resolves project + settings, or while a child
 * route's data is in flight. The surrounding `ItemsShell` is a client wrapper
 * that mounts before this — so this skeleton fills only the middle pane.
 */
export default function ItemsLoading() {
  return (
    <div className="flex h-full flex-col gap-4 p-6">
      <div className="flex items-center gap-3">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-5 w-24" />
        <Skeleton className="ml-auto h-7 w-7 rounded-md" />
      </div>
      <Skeleton className="h-7 w-3/4" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-11/12" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
