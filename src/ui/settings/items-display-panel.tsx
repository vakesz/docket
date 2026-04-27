"use client";

// UI-only preference — see src/lib/ui-prefs.ts. Deliberately not in SETTINGS_CATALOG.

import { fieldClass } from "@/lib/form-classes";
import { RECENT_LIMIT_MAX, useRecentLimit } from "@/lib/ui-prefs";

export function ItemsDisplayPanel() {
  const [limit, setLimit] = useRecentLimit();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-fg">Items pane</h2>
        <p className="text-sm text-fg-muted">
          Browser-local display preferences for the backlog list. Stored on this device only.
        </p>
      </header>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium text-fg">Recently viewed</legend>
        <p className="text-xs text-fg-muted">
          Pin recently-opened items to the top of the backlog so you can hop back without scrolling.
          Set to <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">0</code> to hide the
          Recent section entirely. Maximum {RECENT_LIMIT_MAX}.
        </p>
        <div className="flex items-center gap-3">
          <input
            type="number"
            min={0}
            max={RECENT_LIMIT_MAX}
            step={1}
            value={limit}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              if (!Number.isFinite(next) || next < 0) return;
              setLimit(Math.min(next, RECENT_LIMIT_MAX));
            }}
            className={`${fieldClass} max-w-[6rem]`}
          />
          <span className="text-xs text-fg-muted">
            {limit === 0 ? "Recents are hidden." : `Up to ${limit} item${limit === 1 ? "" : "s"}.`}
          </span>
        </div>
      </fieldset>
    </div>
  );
}
