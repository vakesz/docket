"use client";

import { useEffect } from "react";
import { Button } from "@/ui/primitives/button";

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
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-border bg-card p-6 text-foreground shadow-sm">
        <h1 className="font-semibold text-lg">Something went wrong</h1>
        <p className="text-muted-foreground text-sm">
          The page hit an unexpected error. Try again, or reload if the problem persists.
        </p>
        {error.digest ? (
          <p className="text-muted-foreground/70 text-xs">
            Error ref: <code className="font-mono">{error.digest}</code>
          </p>
        ) : null}
        <Button type="button" onClick={() => reset()} className="self-start">
          Try again
        </Button>
      </div>
    </div>
  );
}
