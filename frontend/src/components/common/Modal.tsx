import type { ReactNode } from "react";
import { cn } from "~/lib/cn";
import { useEscapeKey } from "~/lib/hooks";

/**
 * Centered, dismissive-overlay modal primitive. Wraps the
 * `fixed inset-0 z-50` backdrop, click-outside-to-close, and Escape
 * binding so callers only spell their own header + body. Pass max-width
 * (`max-w-2xl`, `max-w-3xl`) and any other sizing classes via
 * `className`; the panel ships with `flex max-h-[90vh] flex-col` so the
 * inner content can scroll.
 */
export function Modal({
  onClose,
  className,
  children,
  ariaLabel,
}: {
  onClose: () => void;
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
}) {
  useEscapeKey(onClose);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={cn(
          "flex max-h-[90vh] w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
