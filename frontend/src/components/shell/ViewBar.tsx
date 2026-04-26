/**
 * View bar — session-only chip filter on top of the active saved view.
 *
 * SPA equivalent of the TUI chip bar (`src/docket/cli/tui/widgets/view_bar.py`).
 * The bar shows:
 *   - state-bucket cycle (open ↔ closed ↔ all)
 *   - one chip group per facet (`/items/facets`); each option toggles into the
 *     session override via `PATCH /api/runtime/view-overrides`
 *   - a saved-view picker that drops overrides on switch
 *   - "Clear" pill that removes the override entirely (DELETE)
 *
 * When the active provider only exposes one saved view and no facets render
 * any options, the bar collapses to a single state-bucket pill so the chrome
 * stays out of the way.
 */
import {
  useActiveView,
  useClearViewOverrides,
  useFacets,
  useProviders,
  useSetActiveView,
  useSetViewOverrides,
  useViewOverrides,
  useViews,
} from "~/api/hooks";
import { cn } from "~/lib/cn";
import { metaLabelFaintClass } from "~/lib/formClasses";

type StateBucket = "open" | "closed" | "all";

const STATE_CYCLE: Record<StateBucket, StateBucket> = {
  open: "closed",
  closed: "all",
  all: "open",
};

const STATE_LABEL: Record<StateBucket, string> = {
  open: "Open",
  closed: "Done",
  all: "All",
};

export function ViewBar() {
  const providers = useProviders();
  const activeProvider = providers.data?.find((p) => p.active);
  const providerKey = activeProvider?.key ?? null;

  const views = useViews(providerKey);
  const activeView = useActiveView(providerKey);
  const overrides = useViewOverrides();
  const facets = useFacets();

  const setActiveView = useSetActiveView(providerKey ?? "");
  const setOverrides = useSetViewOverrides();
  const clearOverrides = useClearViewOverrides();

  if (!providerKey) return null;

  const present = overrides.data?.present ?? false;
  const view = overrides.data?.view ?? activeView.data;
  if (!view) return null;

  const currentBucket = (view.state_bucket ?? "open") as StateBucket;
  const currentAxes = view.axes ?? {};
  const currentAssignees = view.assignees ?? [];

  const cycleBucket = () => {
    const next = STATE_CYCLE[currentBucket];
    setOverrides.mutate({
      assignees: currentAssignees,
      axes: currentAxes,
      state_bucket: next,
    });
  };

  const toggleAxisValue = (axisKey: string, value: string) => {
    const currentValues = currentAxes[axisKey] ?? [];
    const nextValues = currentValues.includes(value)
      ? currentValues.filter((v) => v !== value)
      : [...currentValues, value];
    const nextAxes = { ...currentAxes };
    if (nextValues.length === 0) delete nextAxes[axisKey];
    else nextAxes[axisKey] = nextValues;
    setOverrides.mutate({
      assignees: currentAssignees,
      axes: nextAxes,
      state_bucket: currentBucket,
    });
  };

  const toggleAssignee = (value: string) => {
    const next = currentAssignees.includes(value)
      ? currentAssignees.filter((v) => v !== value)
      : [...currentAssignees, value];
    setOverrides.mutate({
      assignees: next,
      axes: currentAxes,
      state_bucket: currentBucket,
    });
  };

  const facetData = facets.data ?? [];
  const viewList = views.data ?? [];

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-1.5">
      <span className={metaLabelFaintClass}>View</span>

      {viewList.length > 1 && (
        <select
          value={view.name}
          disabled={setActiveView.isPending}
          onChange={(e) => setActiveView.mutate({ name: e.target.value })}
          className="rounded border border-border bg-bg px-2 py-0.5 text-xs text-fg focus:border-accent focus:outline-none"
        >
          {viewList.map((v) => (
            <option key={v.name} value={v.name}>
              {v.name}
            </option>
          ))}
        </select>
      )}

      <Pill
        active={true}
        label={STATE_LABEL[currentBucket]}
        onClick={cycleBucket}
        title="Cycle state bucket (open → done → all)"
      />

      {facetData.map((facet) => {
        const options = facet.options ?? [];
        if (options.length === 0) return null;
        const isAssignee = facet.key === "assignees";
        const selected = isAssignee ? currentAssignees : (currentAxes[facet.key] ?? []);
        const total = facet.total_options ?? options.length;
        return (
          <span key={facet.key} className="flex items-center gap-1">
            <span className={metaLabelFaintClass}>{facet.label}</span>
            {options.map((opt) => (
              <Pill
                key={opt.value}
                active={selected.includes(opt.value)}
                label={`${opt.value} (${opt.count})`}
                onClick={() =>
                  isAssignee ? toggleAssignee(opt.value) : toggleAxisValue(facet.key, opt.value)
                }
              />
            ))}
            {total > options.length && (
              <span className="font-mono text-[10px] text-fg-faint">+{total - options.length}</span>
            )}
          </span>
        );
      })}

      {present && (
        <button
          type="button"
          onClick={() => clearOverrides.mutate()}
          disabled={clearOverrides.isPending}
          className="rounded-full border border-border px-2 py-0.5 text-[11px] text-fg-muted hover:border-accent hover:text-accent"
        >
          Clear
        </button>
      )}
    </div>
  );
}

function Pill({
  active,
  label,
  onClick,
  title,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px]",
        active
          ? "border-accent bg-accent/10 text-accent"
          : "border-border text-fg-muted hover:border-fg-faint",
      )}
    >
      {label}
    </button>
  );
}
