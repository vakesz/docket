import type { ReactNode } from "react";

/**
 * Small uppercase form label, matching the design system's mono-caps
 * styling. Lifted from four local copies (NewItemModal,
 * McpPresetPickerModal, settings, SetupWizard) into a single primitive;
 * `required` adds the red asterisk used by the setup wizard.
 */
export function Label({ children, required }: { children: ReactNode; required?: boolean }) {
  return (
    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fg-muted">
      {children}
      {required && <span className="ml-1 text-danger">*</span>}
    </span>
  );
}
