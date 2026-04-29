import { Skeleton } from "@/ui/primitives/skeleton";

export default function ProjectLoading() {
  return (
    <div className="flex min-h-[60vh] flex-col gap-4 p-6">
      <Skeleton className="h-6 w-48" />
      <Skeleton className="h-4 w-full max-w-xl" />
      <Skeleton className="h-4 w-3/4 max-w-xl" />
    </div>
  );
}
