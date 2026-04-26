import { useNavigate } from "@tanstack/react-router";

import { useProviders, useSetActiveProvider } from "~/api/hooks";
import { metaLabelFaintClass } from "~/lib/formClasses";

export function ProviderSwitcher() {
  const providers = useProviders();
  const setActive = useSetActiveProvider();
  const navigate = useNavigate();

  if (!providers.data?.length) return null;
  const active = providers.data.find((p) => p.active) ?? providers.data[0];
  if (!active) return null;

  return (
    <label className="flex items-center gap-1.5 text-xs text-fg-muted">
      <span className={metaLabelFaintClass}>Prov</span>
      <select
        value={active.key}
        disabled={setActive.isPending}
        onChange={(e) =>
          setActive.mutate(
            { key: e.target.value },
            {
              // Drop the deep-linked detail route. The same numeric id can
              // resolve to a different real item in another provider, and
              // staying on /items/<id> made the open detail/chat silently
              // re-target the new provider's item with that id.
              onSuccess: () => navigate({ to: "/items" }),
            },
          )
        }
        className="rounded border border-border bg-bg px-2 py-0.5 text-xs text-fg focus:border-accent focus:outline-none"
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
