"use client";

import Link from "next/link";
import { useEffect } from "react";
import { Button } from "@/ui/primitives/button";

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
      <div className="flex w-full max-w-md flex-col gap-4 rounded-2xl border border-border bg-card p-6 text-foreground shadow-sm">
        <h1 className="font-semibold text-lg">Project page failed to load</h1>
        <p className="text-muted-foreground text-sm">{error.message || "Something went wrong."}</p>
        {error.digest ? (
          <p className="text-muted-foreground/70 text-xs">
            Error ref: <code className="font-mono">{error.digest}</code>
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button type="button" onClick={() => reset()}>
            Try again
          </Button>
          <Button asChild variant="outline">
            <Link href="/">Back to projects</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
