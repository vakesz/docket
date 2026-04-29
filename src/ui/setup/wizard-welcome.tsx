"use client";

import { primaryButtonClass } from "@/lib/form-classes";
import { DocketLogo } from "@/ui/setup/docket-logo";
import { ThemePicker } from "@/ui/shell/theme-picker";

export function WizardWelcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex flex-col items-center gap-8 py-6 text-center">
      <DocketLogo size={50} />
      <div className="flex flex-col items-center gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Welcome to Docket</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Browser-first work-item triage. We&rsquo;ll get you signed in and (optionally) talking to
          an LLM. Takes a minute.
        </p>
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <span className="text-xs uppercase tracking-wide text-muted-foreground-faint">Theme</span>
        <ThemePicker />
      </div>
      <button type="button" onClick={onStart} className={primaryButtonClass}>
        Let&rsquo;s set things up
      </button>
    </div>
  );
}
