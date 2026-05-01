"use client";

import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { SEED_LABELS, type SeedKind } from "@/ui/items/suggest-seeds";
import { MarkdownLazy } from "@/ui/markdown/markdown-lazy";

export function Bubble({
  messageRole,
  text,
  seedKind,
}: {
  messageRole: string;
  text: string;
  seedKind?: SeedKind | null;
}) {
  const tone = messageRole === "user" ? "bg-muted text-foreground" : "bg-card text-foreground";
  if (seedKind) {
    return (
      <div className={cn("mb-3 rounded px-3 py-2 text-sm", tone)}>
        <div className="mb-1 text-muted-foreground text-xs uppercase tracking-wide">
          {messageRole}
        </div>
        <div className="inline-flex items-center gap-1.5 text-foreground">
          <Sparkles aria-hidden="true" className="size-3.5" />
          <span>{SEED_LABELS[seedKind]}</span>
        </div>
      </div>
    );
  }
  return (
    <div className={cn("mb-3 rounded px-3 py-2 text-sm", tone)}>
      <div className="mb-1 text-muted-foreground text-xs uppercase tracking-wide">
        {messageRole}
      </div>
      {text ? <MarkdownLazy source={text} className="text-foreground" /> : null}
    </div>
  );
}
