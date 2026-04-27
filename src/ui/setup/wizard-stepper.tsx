"use client";

export type StepperStep = {
  title: string;
  detail: string;
  done: boolean;
};

export function WizardStepper({
  steps,
  activeIndex,
}: {
  steps: StepperStep[];
  activeIndex: number;
}) {
  return (
    <ol className="flex items-stretch gap-2">
      {steps.map((step, i) => {
        const state = step.done
          ? "done"
          : i === activeIndex || (activeIndex === -1 && i === steps.length - 1)
            ? "active"
            : "pending";
        return (
          <li
            key={step.title}
            className={`flex flex-1 items-center gap-3 rounded-2xl border px-3 py-2 ${
              state === "done"
                ? "border-success-fg/30 bg-success-bg/30"
                : state === "active"
                  ? "border-accent/40 bg-surface-alt"
                  : "border-border bg-surface"
            }`}
          >
            <span
              aria-hidden
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                state === "done"
                  ? "bg-success-fg text-bg"
                  : state === "active"
                    ? "bg-accent text-bg"
                    : "bg-surface-alt text-fg-faint"
              }`}
            >
              {state === "done" ? "✓" : i + 1}
            </span>
            <span className="flex flex-col leading-tight">
              <span
                className={`text-sm font-medium ${
                  state === "pending" ? "text-fg-muted" : "text-fg"
                }`}
              >
                {step.title}
              </span>
              <span className="text-xs text-fg-faint">{step.detail}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
