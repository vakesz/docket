"use client";
import { trpc } from "@/lib/trpc-client";

const THEME_OPTIONS = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

export function SettingsForm() {
  const utils = trpc.useUtils();
  const catalog = trpc.settings.catalog.useQuery();
  const list = trpc.settings.list.useQuery();
  const update = trpc.settings.update.useMutation({
    onSuccess: async () => {
      await utils.settings.list.invalidate();
    },
  });
  const reset = trpc.settings.reset.useMutation({
    onSuccess: async () => {
      await utils.settings.list.invalidate();
    },
  });

  if (catalog.isPending || list.isPending) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }
  if (catalog.error || list.error) {
    return (
      <p className="text-sm text-red-600">
        {catalog.error?.message ?? list.error?.message ?? "failed to load settings"}
      </p>
    );
  }

  const valueByKey = new Map(list.data.map((row) => [row.key, row.value]));

  return (
    <div className="flex flex-col gap-6">
      {catalog.data.map((entry) => {
        const value = valueByKey.get(entry.key) ?? entry.default;
        return (
          <div
            key={entry.key}
            className="flex flex-col gap-2 rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800"
          >
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={`setting-${entry.key}`} className="text-base font-medium">
                {entry.label}
              </label>
              <button
                type="button"
                className="text-xs text-zinc-500 hover:text-zinc-800 disabled:opacity-50 dark:hover:text-zinc-200"
                disabled={reset.isPending}
                onClick={() => reset.mutate({ key: entry.key as never })}
              >
                Reset to default
              </button>
            </div>
            <p className="text-xs text-zinc-500">{entry.description}</p>

            {entry.key === "ui.theme" ? (
              <select
                id={`setting-${entry.key}`}
                className="mt-1 w-fit rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                value={value as string}
                disabled={update.isPending}
                onChange={(e) => update.mutate({ key: "ui.theme" as never, value: e.target.value })}
              >
                {THEME_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : entry.key === "chat.send-on-enter" ? (
              <label className="mt-1 inline-flex items-center gap-2 text-sm">
                <input
                  id={`setting-${entry.key}`}
                  type="checkbox"
                  checked={value === true}
                  disabled={update.isPending}
                  onChange={(e) =>
                    update.mutate({
                      key: "chat.send-on-enter" as never,
                      value: e.target.checked,
                    })
                  }
                />
                <span>Enabled</span>
              </label>
            ) : (
              <p className="text-xs text-amber-600">No editor wired for this key.</p>
            )}
          </div>
        );
      })}
      {update.error ? <p className="text-sm text-red-600">{update.error.message}</p> : null}
    </div>
  );
}
