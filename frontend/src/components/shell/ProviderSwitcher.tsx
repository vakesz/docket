import { useProviders, useSetActiveProvider } from "~/api/hooks";

export function ProviderSwitcher() {
  const providers = useProviders();
  const setActive = useSetActiveProvider();

  if (!providers.data?.length) return null;
  const active = providers.data.find((p) => p.active) ?? providers.data[0];
  if (!active) return null;

  return (
    <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
      <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">Prov</span>
      <select
        value={active.key}
        disabled={setActive.isPending}
        onChange={(e) => setActive.mutate({ key: e.target.value })}
        className="rounded border border-zinc-200 bg-white px-2 py-0.5 text-xs focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
      >
        {providers.data.map((p) => (
          <option key={p.key} value={p.key}>
            {p.display_name}
          </option>
        ))}
      </select>
    </label>
  );
}
