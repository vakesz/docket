import { useScopes, useSetActiveScope } from "~/api/hooks";

/**
 * Inline scope picker. Returns `null` unless the active provider exposes more
 * than one scope so the chrome stays minimal when there's nothing to choose.
 */
export function ScopeSwitcher() {
  const scopes = useScopes();
  const setActive = useSetActiveScope();

  if (!scopes.data?.length || scopes.data.length <= 1) return null;
  const active = scopes.data.find((s) => s.active) ?? scopes.data[0];
  if (!active) return null;

  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5">
      <span className="font-mono text-[10px] uppercase tracking-wider text-fg-faint">Scope</span>
      <select
        value={active.name}
        disabled={setActive.isPending}
        onChange={(e) => setActive.mutate({ name: e.target.value })}
        className="flex-1 rounded border border-border bg-bg px-2 py-0.5 text-xs text-fg focus:border-accent focus:outline-none"
      >
        {scopes.data.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
    </div>
  );
}
