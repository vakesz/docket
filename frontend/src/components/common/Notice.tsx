import { CheckCircle2, CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

/**
 * Single-tone callout box used for inline error / warning / success
 * messages. Replaces four near-identical local copies that previously
 * lived inside settings, NewItemModal, McpServerForm, and
 * McpPresetPickerModal.
 */
export function Notice({
  title,
  children,
  tone,
  className,
}: {
  title: string;
  children: ReactNode;
  tone: "error" | "warning" | "ok";
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border px-4 py-3 text-sm",
        tone === "error"
          ? "border-danger bg-danger-bg text-danger-fg"
          : tone === "ok"
            ? "border-success bg-success-bg text-success-fg"
            : "border-warning bg-warning-bg text-warning-fg",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        {tone === "ok" ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
        ) : (
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        )}
        <div>
          <div className="font-semibold">{title}</div>
          <div className="mt-1 leading-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
