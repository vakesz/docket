import { useScopes, useSetActiveScope } from "~/api/hooks";

export function ScopeSwitcher() {
  const scopes = useScopes();
  const setActive = useSetActiveScope();

  if (!scopes.data?.length) return null;
  const active = scopes.data.find((s) => s.active) ?? scopes.data[0];
  if (!active) return null;

  return (
    <label className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-400">
      <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-400">Scope</span>
      <select
        value={active.name}
        disabled={setActive.isPending}
        onChange={(e) => setActive.mutate({ name: e.target.value })}
        className="rounded border border-zinc-200 bg-white px-2 py-0.5 text-xs focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
      >
        {scopes.data.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
    </label>
  );
}
