"use client";

export type StepperStep = {
  title: string;
  done: boolean;
};

/**
 * Thin progress indicator: a horizontal hairline with one named dot per
 * step. Three visual states — empty (pending), filled (done), filled +
 * outer ring (current). Labels under each dot.
 */
export function WizardStepper({
  steps,
  activeIndex,
}: {
  steps: StepperStep[];
  activeIndex: number;
}) {
  const inset = `${50 / steps.length}%`;
  return (
    <ol className="relative flex w-full items-start">
      <span
        aria-hidden
        className="pointer-events-none absolute top-1.5 h-px -translate-y-1/2 bg-border"
        style={{ left: inset, right: inset }}
      />
      {steps.map((step, i) => {
        const state = step.done ? "done" : i === activeIndex ? "active" : "pending";
        return (
          <li key={step.title} className="flex flex-1 flex-col items-center">
            <span
              aria-hidden
              className={`relative h-3 w-3 rounded-full ${
                state === "done"
                  ? "bg-fg"
                  : state === "active"
                    ? "bg-fg ring-2 ring-fg ring-offset-2 ring-offset-bg"
                    : "border border-border bg-bg"
              }`}
            />
            <span className={`mt-3 text-xs ${state === "pending" ? "text-fg-faint" : "text-fg"}`}>
              {step.title}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
