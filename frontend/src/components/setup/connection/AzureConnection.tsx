import { useEffect, useState } from "react";
import type { DTO } from "~/api/client";
import { useAdoDiscover } from "~/api/hooks";
import { Label } from "~/components/common/Label";
import { Combobox } from "./Combobox";

export function AzureConnection({
  config,
  onChange,
  cli,
}: {
  config: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
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
    const org = config.organization;
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
  }, [cli?.az.logged_in, config.organization]);

  return (
    <>
      <section className="flex flex-col gap-2">
        <Label required>Azure DevOps organization URL</Label>
        <Combobox
          value={config.organization ?? ""}
          options={orgOptions}
          placeholder="https://dev.azure.com/your-org"
          onChange={(v) => {
            const trimmed = v.trim().replace(/\/$/, "");
            onChange({ ...config, organization: trimmed });
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
          value={config.project ?? ""}
          options={projectOptions}
          placeholder="Project name"
          onChange={(v) => onChange({ ...config, project: v })}
          loading={discover.isPending}
          emptyHint={
            projectError
              ? `Discovery failed (${projectError}); enter the project manually.`
              : config.organization
                ? "Type to filter, or enter a custom project name."
                : "Pick or enter an organization first."
          }
        />
      </section>
    </>
  );
}
