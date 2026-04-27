"use client";
import { trpc } from "@/lib/trpc-client";

/**
 * Per-user settings form.
 *
 * Renders one editor per user-scoped catalog entry. Theme is intentionally
 * NOT in the catalog (it's browser-local via the top-bar ThemePicker), so
 * this form only ever surfaces the small set of per-user preferences that
 * actually live on the server.
 */
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
    return <p className="text-sm text-fg-faint">Loading…</p>;
  }
  if (catalog.error || list.error) {
    return (
      <p className="text-sm text-danger-fg">
        {catalog.error?.message ?? list.error?.message ?? "failed to load settings"}
      </p>
    );
  }

  const valueByKey = new Map(list.data.map((row) => [row.key, row.value]));
  const userEntries = catalog.data.filter((entry) => entry.scope === "user");

  return (
    <div className="flex flex-col gap-6">
      {userEntries.map((entry) => {
        const value = valueByKey.get(entry.key) ?? entry.default;
        return (
          <div
            key={entry.key}
            className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4 text-sm"
          >
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={`setting-${entry.key}`} className="text-base font-medium text-fg">
                {entry.label}
              </label>
              <button
                type="button"
                className="text-xs text-fg-faint hover:text-fg disabled:opacity-50"
                disabled={reset.isPending}
                onClick={() => reset.mutate({ key: entry.key as never })}
              >
                Reset to default
              </button>
            </div>
            <p className="text-xs text-fg-muted">{entry.description}</p>

            {entry.key === "chat.send-on-enter" ? (
              <label className="mt-1 inline-flex items-center gap-2 text-sm text-fg">
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
              <p className="text-xs text-warning-fg">No editor wired for this key.</p>
            )}
          </div>
        );
      })}
      {update.error ? <p className="text-sm text-danger-fg">{update.error.message}</p> : null}
    </div>
  );
}
