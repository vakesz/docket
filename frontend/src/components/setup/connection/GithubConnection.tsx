import { useEffect, useState } from "react";
import type { DTO } from "~/api/client";
import { useGithubDiscover } from "~/api/hooks";
import { Label } from "~/components/common/Label";
import { Combobox } from "./Combobox";

export function GithubConnection({
  config,
  onChange,
  cli,
}: {
  config: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  cli: DTO["CliStatusDTO"] | null;
}) {
  const discover = useGithubDiscover();
  const [repoOptions, setRepoOptions] = useState<string[]>([]);
  const [discoveryError, setDiscoveryError] = useState("");
  const ghHosts = cli?.gh_hosts ?? [];
  const hostOptions = ghHosts.map((h) => h.hostname);

  // Local state so the host combobox can be edited without committing the
  // canonical base_url until the user picks something.
  const [host, setHostState] = useState<string>(() => deriveHost(config.base_url ?? ""));

  useEffect(() => {
    if (!cli?.gh.logged_in) {
      setRepoOptions([]);
      return;
    }
    let cancelled = false;
    discover.mutate(
      { stage: "repos", host, org: "" },
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
  }, [cli?.gh.logged_in, host]);

  const apiBaseFor = (hostname: string): string => {
    const match = ghHosts.find((h) => h.hostname === hostname);
    if (match) return match.api_base_url;
    if (!hostname || hostname === "github.com") return "https://api.github.com";
    return `https://${hostname}/api/v3`;
  };

  const setHost = (hostname: string) => {
    setHostState(hostname);
    const next: Record<string, string> = { ...config };
    if (!hostname || hostname === "github.com") {
      delete next.base_url;
    } else {
      next.base_url = apiBaseFor(hostname);
    }
    onChange(next);
  };

  return (
    <>
      <section className="flex flex-col gap-2">
        <Label>GitHub host</Label>
        <Combobox
          value={host}
          options={hostOptions}
          placeholder="github.com"
          onChange={setHost}
          emptyHint="No `gh auth login` hosts found — type a hostname (e.g. github.com or ghe.example.com)."
        />
      </section>

      <section className="flex flex-col gap-2">
        <Label required>Default repository</Label>
        <Combobox
          value={config.default_repo ?? ""}
          options={repoOptions}
          placeholder="owner/name (e.g. anthropics/claude-code)"
          onChange={(v) => onChange({ ...config, default_repo: v })}
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

function deriveHost(baseUrl: string): string {
  if (!baseUrl) return "";
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}
