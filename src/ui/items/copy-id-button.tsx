"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function CopyIdButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cancel a pending reset on unmount so an unmount-after-click doesn't
  // queue a setState into a torn-down component.
  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  const onCopy = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API can be denied (insecure context, permission); silently degrade.
    }
  };

  const Icon = copied ? Check : Copy;
  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? "Copied" : `Copy ${value}`}
      aria-label={copied ? "Copied" : `Copy ${value} to clipboard`}
      className={cn(
        "inline-flex items-center gap-1 rounded font-mono text-[10px] text-muted-foreground-faint transition-colors hover:bg-muted hover:text-foreground",
        "px-1 py-0.5",
        className,
      )}
    >
      <span>{value}</span>
      <Icon aria-hidden="true" className="h-3 w-3" />
    </button>
  );
}
