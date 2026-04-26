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
import { useEffect, useMemo, useState } from "react";
import type { DTO } from "~/api/client";
import {
  useAdoDiscover,
  useCliStatus,
  useGithubDiscover,
  useSuggestLabel,
  useTestProvider,
} from "~/api/hooks";
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
                    github_host: "",
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
          selected={selected}
          draft={draft}
          setDraft={setDraft}
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

function ConnectionFields({
  selected,
  draft,
  setDraft,
  cli,
}: {
  selected: DTO["SetupProviderTypeDTO"];
  draft: ProviderDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
  cli: DTO["CliStatusDTO"] | null;
}) {
  if (selected.id === "github") {
    return <GithubConnection draft={draft} setDraft={setDraft} cli={cli} />;
  }
  if (selected.id === "azure_devops") {
    return <AzureConnection draft={draft} setDraft={setDraft} cli={cli} />;
  }
  return <GenericConnection selected={selected} draft={draft} setDraft={setDraft} />;
}

function GenericConnection({
  selected,
  draft,
  setDraft,
}: {
  selected: DTO["SetupProviderTypeDTO"];
  draft: ProviderDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
}) {
  return (
    <>
      {selected.fields?.map((field) => (
        <section key={field.key} className="flex flex-col gap-2">
          <Label required={field.required}>{field.label}</Label>
          <TextInput
            value={draft.config[field.key] ?? ""}
            onChange={(v) => setDraft((d) => ({ ...d, config: { ...d.config, [field.key]: v } }))}
            type={field.kind === "secret" ? "password" : "text"}
            placeholder={field.placeholder}
          />
          {field.help && <HelpText>{field.help}</HelpText>}
        </section>
      ))}
    </>
  );
}

function GithubConnection({
  draft,
  setDraft,
  cli,
}: {
  draft: ProviderDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
  cli: DTO["CliStatusDTO"] | null;
}) {
  const discover = useGithubDiscover();
  const [repoOptions, setRepoOptions] = useState<string[]>([]);
  const [discoveryError, setDiscoveryError] = useState("");
  const ghHosts = cli?.gh_hosts ?? [];
  const hostOptions = ghHosts.map((h) => h.hostname);

  // Refresh repo list whenever the host changes.
  useEffect(() => {
    if (!cli?.gh.logged_in) {
      setRepoOptions([]);
      return;
    }
    let cancelled = false;
    discover.mutate(
      { stage: "repos", host: draft.github_host, org: "" },
      {
        onSuccess: (res) => {
          if (cancelled) return;
          if (!res.ok) {
            setRepoOptions([]);
            setDiscoveryError(res.error ?? "");
            return;
          }
          setRepoOptions((res.repos ?? []).map((r) => r.full_name));
          setDiscoveryError("");
        },
        onError: () => {
          if (!cancelled) setRepoOptions([]);
        },
      },
    );
    return () => {
      cancelled = true;
    };
    // discover.mutate is stable; only host changes need to refire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cli?.gh.logged_in, draft.github_host]);

  const apiBaseFor = (hostname: string): string => {
    const match = ghHosts.find((h) => h.hostname === hostname);
    if (match) return match.api_base_url;
    if (!hostname || hostname === "github.com") return "https://api.github.com";
    return `https://${hostname}/api/v3`;
  };

  const setHost = (hostname: string) => {
    setDraft((d) => {
      const config: Record<string, string> = { ...d.config };
      if (!hostname || hostname === "github.com") {
        delete config.base_url;
      } else {
        config.base_url = apiBaseFor(hostname);
      }
      return { ...d, github_host: hostname, config };
    });
  };

  return (
    <>
      <section className="flex flex-col gap-2">
        <Label>GitHub host</Label>
        <Combobox
          value={draft.github_host}
          options={hostOptions}
          placeholder="github.com"
          onChange={setHost}
          emptyHint="No `gh auth login` hosts found — type a hostname (e.g. github.com or ghe.example.com)."
        />
      </section>

      <section className="flex flex-col gap-2">
        <Label required>Default repository</Label>
        <Combobox
          value={draft.config.default_repo ?? ""}
          options={repoOptions}
          placeholder="owner/name (e.g. anthropics/claude-code)"
          onChange={(v) => setDraft((d) => ({ ...d, config: { ...d.config, default_repo: v } }))}
          loading={discover.isPending}
          emptyHint={
            discoveryError
              ? `Discovery failed (${discoveryError}); enter the repo manually.`
              : cli?.gh.logged_in
                ? "Type to filter, or enter any repo you can read."
                : "Sign in to `gh` for autocomplete, or type a repo manually."
          }
        />
      </section>
    </>
  );
}

function AzureConnection({
  draft,
  setDraft,
  cli,
}: {
  draft: ProviderDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
  cli: DTO["CliStatusDTO"] | null;
}) {
  const discover = useAdoDiscover();
  const [orgOptions, setOrgOptions] = useState<string[]>([]);
  const [projectOptions, setProjectOptions] = useState<string[]>([]);
  const [orgError, setOrgError] = useState("");
  const [projectError, setProjectError] = useState("");

  useEffect(() => {
    if (!cli?.az.logged_in) {
      setOrgOptions([]);
      return;
    }
    let cancelled = false;
    discover.mutate(
      { stage: "orgs", org: "", project: "" },
      {
        onSuccess: (res) => {
          if (cancelled) return;
          if (!res.ok) {
            setOrgOptions([]);
            setOrgError(res.error ?? "");
            return;
          }
          setOrgOptions((res.orgs ?? []).map((o) => o.url));
          setOrgError("");
        },
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cli?.az.logged_in]);

  useEffect(() => {
    const org = draft.config.organization;
    if (!org || !cli?.az.logged_in) {
      setProjectOptions([]);
      return;
    }
    let cancelled = false;
    discover.mutate(
      { stage: "projects", org, project: "" },
      {
        onSuccess: (res) => {
          if (cancelled) return;
          if (!res.ok) {
            setProjectOptions([]);
            setProjectError(res.error ?? "");
            return;
          }
          setProjectOptions(res.projects ?? []);
          setProjectError("");
        },
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cli?.az.logged_in, draft.config.organization]);

  return (
    <>
      <section className="flex flex-col gap-2">
        <Label required>Azure DevOps organization URL</Label>
        <Combobox
          value={draft.config.organization ?? ""}
          options={orgOptions}
          placeholder="https://dev.azure.com/your-org"
          onChange={(v) => {
            const trimmed = v.trim().replace(/\/$/, "");
            setDraft((d) => ({ ...d, config: { ...d.config, organization: trimmed } }));
          }}
          loading={discover.isPending}
          emptyHint={
            orgError
              ? `Discovery failed (${orgError}); enter the URL manually.`
              : cli?.az.logged_in
                ? "Type to filter, or enter a custom org URL."
                : "Sign in to `az` for autocomplete, or enter the URL manually."
          }
        />
      </section>

      <section className="flex flex-col gap-2">
        <Label required>Project</Label>
        <Combobox
          value={draft.config.project ?? ""}
          options={projectOptions}
          placeholder="Project name"
          onChange={(v) => setDraft((d) => ({ ...d, config: { ...d.config, project: v } }))}
          loading={discover.isPending}
          emptyHint={
            projectError
              ? `Discovery failed (${projectError}); enter the project manually.`
              : draft.config.organization
                ? "Type to filter, or enter a custom project name."
                : "Pick or enter an organization first."
          }
        />
      </section>
    </>
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
  useEffect(() => {
    if (draft.display_name_dirty || !draft.type) return;
    suggest.mutate(
      { type: draft.type, config: { ...draft.config }, github_host: draft.github_host },
      {
        onSuccess: (res) => {
          setDraft((d) => {
            if (d.display_name_dirty) return d;
            return { ...d, display_name: res.label };
          });
        },
      },
    );
    // Only refire on config-relevant changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    draft.type,
    draft.github_host,
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

function Combobox({
  value,
  options,
  onChange,
  placeholder,
  loading,
  emptyHint,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
  placeholder?: string;
  loading?: boolean;
  emptyHint?: string;
}) {
  const id = useMemo(() => `combo-${Math.random().toString(36).slice(2, 9)}`, []);

  return (
    <>
      <input
        list={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg",
          "focus:border-accent focus:outline-none",
        )}
      />
      <datalist id={id}>
        {options.map((opt) => (
          <option key={opt} value={opt} />
        ))}
      </datalist>
      {loading && <span className="text-xs text-fg-muted">Loading…</span>}
      {!loading && options.length === 0 && emptyHint && <HelpText>{emptyHint}</HelpText>}
    </>
  );
}
