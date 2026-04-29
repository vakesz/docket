import Link from "next/link";
import { primaryButtonClass } from "@/lib/form-classes";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-border bg-card p-6 text-foreground shadow-sm">
        <h1 className="text-lg font-semibold">Not found</h1>
        <p className="text-sm text-muted-foreground">
          That page doesn&rsquo;t exist, or you don&rsquo;t have access to it.
        </p>
        <Link href="/" className={`${primaryButtonClass} self-start`}>
          Back to projects
        </Link>
      </div>
    </div>
  );
}
