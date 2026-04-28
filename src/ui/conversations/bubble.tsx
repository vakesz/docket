"use client";

import { Sparkles } from "lucide-react";
import { metaLabelClass } from "@/lib/form-classes";
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
  const tone = messageRole === "user" ? "bg-surface-alt text-fg" : "bg-surface text-fg";
  if (seedKind) {
    return (
      <div className={cn("mb-3 rounded px-3 py-2 text-sm", tone)}>
        <div className={cn("mb-1", metaLabelClass)}>{messageRole}</div>
        <div className="inline-flex items-center gap-1.5 text-fg">
          <Sparkles aria-hidden="true" className="size-3.5" />
          <span>{SEED_LABELS[seedKind]}</span>
        </div>
      </div>
    );
  }
  return (
    <div className={cn("mb-3 rounded px-3 py-2 text-sm", tone)}>
      <div className={cn("mb-1", metaLabelClass)}>{messageRole}</div>
      {text ? <MarkdownLazy source={text} className="text-fg" /> : null}
    </div>
  );
}
