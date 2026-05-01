"use client";

import { Button } from "@/ui/primitives/button";
import { DocketLogo } from "@/ui/setup/docket-logo";
import { ThemePicker } from "@/ui/shell/theme-picker";

export function WizardWelcome({ onStart }: { onStart: () => void }) {
  return (
    <div className="flex flex-col items-center gap-8 py-6 text-center">
      <DocketLogo size={50} />
      <div className="flex flex-col items-center gap-2">
        <h1 className="font-semibold text-2xl text-foreground tracking-tight">Welcome to Docket</h1>
        <p className="max-w-md text-muted-foreground text-sm">
          Browser-first work-item triage. We&rsquo;ll get you signed in and (optionally) talking to
          an LLM. Takes a minute.
        </p>
      </div>
      <div className="flex flex-col items-center gap-1.5">
        <span className="text-muted-foreground/70 text-xs uppercase tracking-wide">Theme</span>
        <ThemePicker />
      </div>
      <Button type="button" onClick={onStart}>
        Let&rsquo;s set things up
      </Button>
    </div>
  );
}
