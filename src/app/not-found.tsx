import Link from "next/link";
import { primaryButtonClass } from "@/lib/form-classes";

export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-border bg-surface p-6 text-fg shadow-sm">
        <h1 className="text-lg font-semibold">Not found</h1>
        <p className="text-sm text-fg-muted">
          That page doesn&rsquo;t exist, or you don&rsquo;t have access to it.
        </p>
        <Link href="/" className={`${primaryButtonClass} self-start`}>
          Back to projects
        </Link>
      </div>
    </div>
  );
}
