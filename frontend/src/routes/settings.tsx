import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";

import { usePatchSettings, useSettings } from "~/api/hooks";
import { cn } from "~/lib/cn";

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  const settings = useSettings();
  const patch = usePatchSettings();
  const [draft, setDraft] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);

  const initial = useMemo(
    () => (settings.data ? JSON.stringify(settings.data.config, null, 2) : ""),
    [settings.data],
  );

  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  const dirty = draft !== initial;

  const save = () => {
    try {
      const parsed = JSON.parse(draft) as Record<string, unknown>;
      setParseError(null);
      patch.mutate({ patch: parsed });
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col overflow-auto p-6">
      <header className="mb-4 flex items-baseline gap-3">
        <h1 className="text-lg font-semibold">Settings</h1>
        <span className="font-mono text-[11px] text-zinc-500">config.toml (masked secrets)</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setDraft(initial)}
            disabled={!dirty}
            className="rounded border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-800 dark:hover:bg-zinc-900"
          >
            Revert
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || patch.isPending}
            className="rounded bg-accent px-3 py-1 text-xs font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {patch.isPending ? "Saving…" : "Save"}
          </button>
        </div>
      </header>

      {parseError && (
        <div className="mb-3 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {parseError}
        </div>
      )}
      {patch.error && (
        <div className="mb-3 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {patch.error.message}
        </div>
      )}
      {patch.data?.requires_restart?.length ? (
        <div className="mb-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          Restart required for: {patch.data.requires_restart.join(", ")}
        </div>
      ) : null}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        className={cn(
          "h-full min-h-[480px] w-full flex-1 rounded border border-zinc-200 bg-white p-3",
          "font-mono text-xs leading-relaxed focus:border-accent focus:outline-none",
          "dark:border-zinc-800 dark:bg-zinc-950",
        )}
      />
    </div>
  );
}
