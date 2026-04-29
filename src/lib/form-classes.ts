/**
 * Shared Tailwind class strings.
 *
 * Centralizing button/input class strings keeps the visual language
 * consistent across the shell, settings, admin, and proposal surfaces.
 * All values use the semantic theme tokens (bg-background, text-foreground, border-border,
 * etc.) so swapping themes flows everywhere without per-component edits.
 */

export const fieldClass =
  "w-full rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground-faint focus:border-primary focus:outline-none";

export const fieldMonoClass =
  "w-full rounded-xl border border-border bg-card px-3 py-2 font-mono text-sm text-foreground placeholder:text-muted-foreground-faint focus:border-primary focus:outline-none";

/**
 * Native `<select>` wearing the same chrome as {@link fieldClass}. Strips
 * the platform's default chevron via `appearance-none` and reserves
 * room on the right for a custom one — callers overlay a `lucide`
 * ChevronDown (typically via `<SelectField>`) so the select renders at
 * the same height as adjacent text inputs across browsers.
 */
export const selectFieldClass =
  "w-full appearance-none rounded-xl border border-border bg-card pl-3 pr-8 py-2 text-sm text-foreground placeholder:text-muted-foreground-faint focus:border-primary focus:outline-none disabled:cursor-not-allowed disabled:opacity-60";

export const primaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground shadow-sm hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

export const secondaryButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";

export const outlineButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-transparent px-4 py-2 text-sm font-medium text-foreground hover:bg-card disabled:cursor-not-allowed disabled:opacity-60";

export const dangerButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm font-semibold text-destructive hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-60";

export const sidebarActionClass =
  "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted hover:text-foreground";

export const iconCloseButtonClass =
  "inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground-faint hover:bg-muted hover:text-foreground";

export const xsBorderButtonClass =
  "inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";

export const xsAccentButtonClass =
  "inline-flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

export const xsDangerButtonClass =
  "inline-flex items-center gap-1 rounded-md border border-destructive/40 bg-card px-2 py-1 text-xs text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60";

/** Small uppercase pill (e.g. status / kind tag inside list rows). */
export const badgeClass =
  "inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground";

/** Accent variant of {@link badgeClass} — the "default" pill on selected rows. */
export const accentBadgeClass =
  "inline-flex items-center rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground";

/** Inline error message below a form. */
export const errorMessageClass =
  "rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive";

/** Empty-state panel for list surfaces (no rows yet). */
export const emptyStateClass =
  "rounded-2xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground";

export const microCapsButtonClass =
  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-muted hover:text-foreground";

export const metaLabelClass = "text-xs uppercase tracking-wide text-muted-foreground";

export const metaLabelFaintClass = "text-xs uppercase tracking-wide text-muted-foreground-faint";

export const dangerTextClass = "text-sm text-destructive";

/** Settings & admin page panel. Use for each grouped section. */
export const settingsPanelClass = "rounded-2xl border border-border bg-card p-6 shadow-sm";

/** Settings & admin page row inside a panel. */
export const settingsRowClass =
  "flex flex-col gap-2 border-t border-border first:border-t-0 first:pt-0 pt-4";

export const SEPARATOR =
  "bg-border transition-colors data-[resize-handle-state=hover]:bg-muted-foreground-faint data-[resize-handle-state=drag]:bg-primary";

/**
 * Headless UI `<Switch>` track. Use as the Switch's own `className`. The
 * thumb lives as a child `<span>` styled by {@link switchThumbClass}.
 */
export const switchTrackClass =
  "group relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border bg-muted transition-colors focus:outline-none data-checked:border-primary data-checked:bg-primary data-disabled:cursor-not-allowed data-disabled:opacity-60 data-focus:ring-3 data-focus:ring-ring/50";

/** Sliding thumb child of a Headless UI `<Switch>`. */
export const switchThumbClass =
  "ml-0.5 inline-block h-4 w-4 rounded-full bg-foreground shadow-sm transition-transform group-data-checked:translate-x-4 group-data-checked:bg-primary-foreground";

/** Transparent button (no border, no background until hover). */
export const ghostButtonClass =
  "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";
