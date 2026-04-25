import type { ReactNode } from "react";

export function Label({ children, required }: { children: ReactNode; required?: boolean }) {
  return (
    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted">
      {children}
      {required && <span className="ml-1 text-danger">*</span>}
    </span>
  );
}
