import { primaryButtonClass, setupCardClass } from "~/lib/formClasses";

export function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className={setupCardClass}>
      <p>
        Docket is ready to configure. The web wizard mirrors{" "}
        <code className="rounded bg-surface-alt px-1 text-fg">docket setup</code> step by step:
        we'll probe your local <code className="rounded bg-surface-alt px-1 text-fg">gh</code> /{" "}
        <code className="rounded bg-surface-alt px-1 text-fg">az</code> sessions, walk you through a
        provider, scope filter, optional Azure OpenAI deployment, and host settings, then write{" "}
        <code className="rounded bg-surface-alt px-1 text-fg">config.toml</code>.
      </p>
      <p className="text-fg-muted">
        You can re-run the wizard from the terminal at any time with{" "}
        <code className="rounded bg-surface-alt px-1 text-fg">docket setup</code> — both surfaces
        write the same file.
      </p>
      <div className="flex justify-end">
        <button type="button" onClick={onNext} className={primaryButtonClass}>
          Start
        </button>
      </div>
    </div>
  );
}
