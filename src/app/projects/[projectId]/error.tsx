"use client";

import Link from "next/link";
import { useEffect } from "react";
import { primaryButtonClass, secondaryButtonClass } from "@/lib/form-classes";

/**
 * Project-scope error boundary. Catches failures inside any project page so
 * a single failed item or broken provider call doesn't blow up the root.
 */
export default function ProjectError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[project-error]", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-border bg-surface p-6 text-fg shadow-sm">
        <h1 className="text-lg font-semibold">Project page failed to load</h1>
        <p className="text-sm text-fg-muted">{error.message || "Something went wrong."}</p>
        {error.digest ? (
          <p className="text-xs text-fg-faint">
            Error ref: <code className="font-mono">{error.digest}</code>
          </p>
        ) : null}
        <div className="flex gap-2">
          <button type="button" onClick={() => reset()} className={primaryButtonClass}>
            Try again
          </button>
          <Link href="/" className={secondaryButtonClass}>
            Back to projects
          </Link>
        </div>
      </div>
    </div>
  );
}
