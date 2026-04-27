/**
 * Shared Tailwind class strings.
 *
 * Centralizing button/input class strings keeps the visual language
 * consistent across the shell, settings, admin, and proposal surfaces.
 * All values use the semantic theme tokens (bg-bg, text-fg, border-border,
 * etc.) so swapping themes flows everywhere without per-component edits.
 */

export const fieldClass =
  "w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none";

export const fieldMonoClass =
  "w-full rounded-xl border border-border bg-surface px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none";

export const primaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-accent-fg shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

export const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface px-4 py-2 text-sm font-medium text-fg hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-60";

export const outlineButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-transparent px-4 py-2 text-sm font-medium text-fg hover:bg-surface disabled:cursor-not-allowed disabled:opacity-60";

export const dangerButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-danger/40 bg-danger-bg px-4 py-2 text-sm font-semibold text-danger-fg hover:bg-danger-bg/80 disabled:cursor-not-allowed disabled:opacity-60";

export const sidebarActionClass =
  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-fg-muted hover:bg-surface-alt hover:text-fg";

export const iconCloseButtonClass =
  "inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-faint hover:bg-surface-alt hover:text-fg";

export const xsBorderButtonClass =
  "inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-xs text-fg hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-60";

export const xsAccentButtonClass =
  "inline-flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-semibold text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

export const microCapsButtonClass =
  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-muted hover:bg-surface-alt hover:text-fg";

export const metaLabelClass = "text-xs uppercase tracking-wide text-fg-muted";

export const metaLabelFaintClass = "text-xs uppercase tracking-wide text-fg-faint";

/** Setup wizard / setup-required page card. Centered, large, tactile. */
export const setupCardClass =
  "w-full max-w-2xl rounded-3xl border border-border bg-surface p-8 shadow-xl";

export const dangerTextClass = "text-sm text-danger-fg";

/** Settings & admin page panel. Use for each grouped section. */
export const settingsPanelClass = "rounded-2xl border border-border bg-surface p-6 shadow-sm";

/** Settings & admin page row inside a panel. */
export const settingsRowClass =
  "flex flex-col gap-2 border-t border-border first:border-t-0 first:pt-0 pt-4";

export const SEPARATOR =
  "bg-border transition-colors data-[resize-handle-state=hover]:bg-fg-faint data-[resize-handle-state=drag]:bg-accent";
