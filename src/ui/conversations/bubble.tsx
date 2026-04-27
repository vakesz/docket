"use client";

import { metaLabelClass } from "@/lib/form-classes";
import { cn } from "@/lib/utils";
import { Markdown } from "@/ui/markdown/markdown";

export function Bubble({
  messageRole,
  text,
  streaming = false,
}: {
  messageRole: string;
  text: string;
  streaming?: boolean;
}) {
  const tone = messageRole === "user" ? "bg-surface-alt text-fg" : "bg-surface text-fg";
  return (
    <div className={cn("mb-3 rounded px-3 py-2 text-sm", tone)}>
      <div className={cn("mb-1", metaLabelClass)}>
        {messageRole}
        {streaming ? " · streaming" : ""}
      </div>
      {text ? (
        <Markdown source={text} className="text-fg" />
      ) : (
        <p className="text-fg">{streaming ? "…" : ""}</p>
      )}
    </div>
  );
}
