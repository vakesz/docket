import { Skeleton } from "@/ui/primitives/skeleton";

export default function SettingsLoading() {
  return (
    <div className="flex min-h-[60vh] gap-6 p-6">
      <div className="flex w-56 flex-col gap-2">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-3/4" />
      </div>
      <div className="flex flex-1 flex-col gap-4">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-3/4 max-w-xl" />
        <Skeleton className="h-32 w-full max-w-2xl" />
      </div>
    </div>
  );
}
