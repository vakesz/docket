/**
 * Provider type + connection step.
 *
 * Web equivalent of `_step_pick_provider` → `_step_provider_connection` →
 * `_step_pick_label` from `setup_wizard.py`. The CLI walks them sequentially;
 * the web fits them on one screen because we have the vertical room.
 *
 * Discovery-driven pickers replace the raw text inputs from the original SPA:
 *   - github       : host picker → repo picker (with manual fallback)
 *   - azure_devops : org picker  → project picker
 *   - other        : raw spec-driven fields (no discovery wired up — same as
 *                    the CLI's `_generic_step_connection` fallthrough)
 *
 * Each picker uses an HTML <datalist> combobox: type-to-filter or pick from
 * the discovered list. When discovery returns an error or empty list, the
 * field collapses to a plain text input — matching the CLI's
 * "couldn't auto-list … entering manually." UX.
 *
 * Display name auto-fills via `/setup/suggest-label` whenever the relevant
 * provider config changes, but only until the user hand-edits the field
 * (`display_name_dirty`).
 */
import { useEffect, useMemo } from "react";
import type { DTO } from "~/api/client";
import { useCliStatus, useSuggestLabel, useTestProvider } from "~/api/hooks";
import { HelpText, TextInput } from "~/components/common/FormInputs";
import { Label } from "~/components/common/Label";
import { Notice } from "~/components/common/Notice";
import { cn } from "~/lib/cn";
import {
  dangerTextClass,
  metaLabelClass,
  primaryButtonClass,
  setupCardClass,
  xsBorderButtonClass,
} from "~/lib/formClasses";
import { ConnectionFields } from "./connection";
import type { ProviderDraft } from "./types";
import { emptyScope } from "./types";

interface Props {
  types: DTO["SetupProviderTypeDTO"][];
  loading: boolean;
  draft: ProviderDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
  onBack: () => void;
  onNext: () => void;
}

export function ProviderStep({ types, loading, draft, setDraft, onBack, onNext }: Props) {
  const cli = useCliStatus();
  const test = useTestProvider();
  const selected = types.find((t) => t.id === draft.type);

  const fieldsValid = useMemo(() => {
    if (!selected) return false;
    return (selected.fields ?? []).every(
      (f) => !f.required || (draft.config[f.key] ?? "").trim().length > 0,
    );
  }, [selected, draft.config]);

  const cliMissing = useMemo(() => {
    if (!selected) return [] as string[];
    const ghOk = cli.data?.gh.logged_in ?? false;
    const azOk = cli.data?.az.logged_in ?? false;
    return (selected.requires_cli ?? []).filter(
      (r) => (r === "gh" && !ghOk) || (r === "az" && !azOk),
    );
  }, [selected, cli.data]);

  return (
    <div className={setupCardClass}>
      <section className="flex flex-col gap-2">
        <Label>Provider type</Label>
        {loading ? (
          <span className="text-xs text-fg-muted">Loading provider types…</span>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {types.map((t) => (
              <ProviderCard
                key={t.id}
                type={t}
                selected={draft.type === t.id}
                ghReady={cli.data?.gh.logged_in ?? false}
                azReady={cli.data?.az.logged_in ?? false}
                onPick={() =>
                  setDraft((d) => ({
                    ...d,
                    type: t.id,
                    key: t.id,
                    display_name: t.display,
                    display_name_dirty: false,
                    config: {},
                    scope: emptyScope(),
                  }))
                }
              />
            ))}
          </div>
        )}
        {selected && cliMissing.length > 0 && (
          <Notice tone="warning" title={`Missing ${cliMissing.join(" / ")} session`}>
            {cliMissing.includes("gh") && (
              <>
                Run <code className="rounded bg-warning-bg/40 px-1">gh auth login</code>.{" "}
              </>
            )}
            {cliMissing.includes("az") && (
              <>
                Run <code className="rounded bg-warning-bg/40 px-1">az login</code>.{" "}
              </>
            )}
            Discovery falls back to manual entry; the connection test below will fail until you sign
            in.
          </Notice>
        )}
      </section>

      {selected && (
        <ConnectionFields
          spec={selected}
          config={draft.config}
          onChange={(next) => setDraft((d) => ({ ...d, config: next }))}
          cli={cli.data ?? null}
        />
      )}

      {selected && <DisplayNameField draft={draft} setDraft={setDraft} />}

      {selected && (
        <section className="flex flex-col gap-2">
          <Label>Internal key</Label>
          <TextInput
            value={draft.key}
            onChange={(v) =>
              setDraft((d) => ({ ...d, key: v.replace(/[^a-z0-9_-]/gi, "_").toLowerCase() }))
            }
            placeholder={selected.id}
          />
          <HelpText>Lowercase identifier used in config.toml — usually the provider type.</HelpText>
        </section>
      )}

      {selected && (
        <section className="flex items-center gap-2 border-t border-border pt-3">
          <button
            type="button"
            disabled={!fieldsValid || test.isPending}
            onClick={() => test.mutate({ type: selected.id, config: draft.config })}
            className={xsBorderButtonClass}
          >
            {test.isPending ? "Testing…" : "Test connection"}
          </button>
          {test.data?.ok && <span className="text-xs text-success-fg">OK</span>}
          {test.data?.ok === false && (
            <span className={dangerTextClass}>{test.data.error ?? "Failed"}</span>
          )}
        </section>
      )}

      <div className="flex justify-between">
        <button type="button" onClick={onBack} className="text-xs text-fg-muted hover:text-fg">
          ← Back
        </button>
        <button
          type="button"
          disabled={!selected || !fieldsValid}
          onClick={onNext}
          className={primaryButtonClass}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function ProviderCard({
  type,
  selected,
  ghReady,
  azReady,
  onPick,
}: {
  type: DTO["SetupProviderTypeDTO"];
  selected: boolean;
  ghReady: boolean;
  azReady: boolean;
  onPick: () => void;
}) {
  const requires = type.requires_cli ?? [];
  const ready =
    requires.length === 0 ||
    requires.every((r) => (r === "gh" ? ghReady : r === "az" ? azReady : true));
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "flex flex-col gap-1 rounded-xl border p-3 text-left",
        selected ? "border-accent bg-accent/5" : "border-border hover:border-fg-faint",
      )}
    >
      <div className="font-medium">{type.display}</div>
      {requires.length > 0 && (
        <div className={cn("flex items-center gap-2", metaLabelClass)}>
          <span>needs: {requires.join(" ")}</span>
          <span className={ready ? "text-success-fg" : "text-warning-fg"}>
            {ready ? "ready" : "not signed in"}
          </span>
        </div>
      )}
    </button>
  );
}

function DisplayNameField({
  draft,
  setDraft,
}: {
  draft: ProviderDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
}) {
  const suggest = useSuggestLabel();

  // Auto-fill the display name from provider config until the user touches it.
  // Only refire on config-relevant changes — adding draft.display_name_dirty,
  // suggest.mutate, draft.config, or setDraft would re-suggest on every keystroke
  // or every render and clobber the user's edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional narrow deps
  useEffect(() => {
    if (draft.display_name_dirty || !draft.type) return;
    suggest.mutate(
      { type: draft.type, config: { ...draft.config } },
      {
        onSuccess: (res) => {
          setDraft((d) => {
            if (d.display_name_dirty) return d;
            return { ...d, display_name: res.label };
          });
        },
      },
    );
  }, [
    draft.type,
    draft.config.organization,
    draft.config.project,
    draft.config.default_repo,
    draft.config.base_url,
  ]);

  return (
    <section className="flex flex-col gap-2">
      <Label>Display name</Label>
      <TextInput
        value={draft.display_name}
        onChange={(v) => setDraft((d) => ({ ...d, display_name: v, display_name_dirty: true }))}
        placeholder="Shown in the provider switcher"
      />
      <HelpText>
        Auto-suggested from your provider config. Edit to override — empty falls back to the
        suggestion.
      </HelpText>
    </section>
  );
}
