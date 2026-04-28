"use client";

import { metaLabelClass } from "@/lib/form-classes";
import { cn } from "@/lib/utils";
import { MarkdownLazy } from "@/ui/markdown/markdown-lazy";

export function Bubble({ messageRole, text }: { messageRole: string; text: string }) {
  const tone = messageRole === "user" ? "bg-surface-alt text-fg" : "bg-surface text-fg";
  return (
    <div className={cn("mb-3 rounded px-3 py-2 text-sm", tone)}>
      <div className={cn("mb-1", metaLabelClass)}>{messageRole}</div>
      {text ? <MarkdownLazy source={text} className="text-fg" /> : null}
    </div>
  );
}
