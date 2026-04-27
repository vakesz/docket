"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

export function CopyIdButton({ value, className }: { value: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(t);
  }, [copied]);

  const onCopy = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
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
        "inline-flex items-center gap-1 rounded font-mono text-[10px] text-fg-faint transition-colors hover:bg-surface-alt hover:text-fg",
        "px-1 py-0.5",
        className,
      )}
    >
      <span>{value}</span>
      <Icon aria-hidden="true" className="h-3 w-3" />
    </button>
  );
}
