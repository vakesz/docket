"use client";

import { useEffect } from "react";
import { primaryButtonClass } from "@/lib/form-classes";

/**
 * Root error boundary for any uncaught error in pages or layouts.
 * Must be a Client Component (Next.js requirement for `error.tsx`).
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[root-error]", error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-bg p-6">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-border bg-surface p-6 text-fg shadow-sm">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="text-sm text-fg-muted">
          The page hit an unexpected error. Try again, or reload if the problem persists.
        </p>
        {error.digest ? (
          <p className="text-xs text-fg-faint">
            Error ref: <code className="font-mono">{error.digest}</code>
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => reset()}
          className={`${primaryButtonClass} self-start`}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
