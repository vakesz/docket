export const fieldClass =
  "w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg focus:border-accent focus:outline-none";

export const fieldMonoClass = `${fieldClass} font-mono`;

export const secondaryButtonClass =
  "inline-flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg hover:bg-surface-alt";

export const primaryButtonClass =
  "inline-flex items-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50";

export const outlineButtonClass =
  "inline-flex items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-bg disabled:cursor-not-allowed disabled:opacity-40";

export const xsBorderButtonClass =
  "rounded border border-border px-3 py-1 text-xs text-fg hover:bg-surface-alt";

export const xsAccentButtonClass =
  "rounded bg-accent px-3 py-1 text-xs font-semibold text-accent-fg hover:bg-accent/90 disabled:opacity-50";

export const microCapsButtonClass =
  "rounded border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-fg-muted hover:bg-surface-alt";

// Tiny uppercase mono labels used for field captions, badges, and switcher
// chrome. `metaLabelClass` is the standard muted variant; `metaLabelFaintClass`
// is for chrome where the label fades behind its value.
export const metaLabelClass = "font-mono text-[10px] uppercase tracking-wider text-fg-muted";

export const metaLabelFaintClass = "font-mono text-[10px] uppercase tracking-wider text-fg-faint";

export const setupCardClass =
  "flex flex-col gap-4 rounded border border-border bg-surface p-6 text-sm text-fg";
