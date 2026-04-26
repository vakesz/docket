"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { trpc } from "@/lib/trpc-client";

const KINDS = ["github", "azure_devops"] as const;
type Kind = (typeof KINDS)[number];

const DEFAULTS: Record<Kind, { label: string; scopes: string; baseUrlHint: string }> = {
  github: {
    label: "GitHub",
    scopes: "read:user user:email repo",
    baseUrlHint: "GitHub Enterprise base URL (leave blank for github.com)",
  },
  azure_devops: {
    label: "Azure DevOps",
    scopes: "499b84ac-1321-427f-aa17-267ca6975798/.default offline_access",
    baseUrlHint: "Entra tenant id (leave blank for `common` / multi-tenant)",
  },
};

export function OauthProviderForm() {
  const router = useRouter();
  const create = trpc.oauthProviders.create.useMutation({
    onSuccess: () => {
      setLabel(DEFAULTS[kind].label);
      setClientId("");
      setClientSecret("");
      setScopes(DEFAULTS[kind].scopes);
      setBaseUrl("");
      router.refresh();
    },
  });

  const [kind, setKind] = useState<Kind>("github");
  const [label, setLabel] = useState(DEFAULTS.github.label);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState(DEFAULTS.github.scopes);
  const [baseUrl, setBaseUrl] = useState("");

  function onKindChange(next: Kind) {
    setKind(next);
    // Reset the kind-specific defaults so the user doesn't have to remember
    // GitHub's scopes when they flip to AzDO and vice versa.
    setLabel(DEFAULTS[next].label);
    setScopes(DEFAULTS[next].scopes);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    create.mutate({
      kind,
      label: label.trim(),
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      scopes: scopes.trim(),
      baseUrl: baseUrl.trim(),
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800"
    >
      <h2 className="text-base font-medium">Add OAuth provider</h2>

      <div className="flex gap-2">
        <label className="flex w-40 flex-col gap-1">
          <span className="text-xs text-zinc-500">Kind</span>
          <select
            value={kind}
            onChange={(e) => onKindChange(e.target.value as Kind)}
            className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-zinc-500">Label</span>
          <input
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
      </div>

      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-zinc-500">Client ID</span>
          <input
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="rounded-md border border-zinc-300 px-2 py-1 font-mono dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-zinc-500">Client secret</span>
          <input
            required
            type="password"
            autoComplete="off"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            className="rounded-md border border-zinc-300 px-2 py-1 font-mono dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-zinc-500">Scopes (space-separated)</span>
        <input
          value={scopes}
          onChange={(e) => setScopes(e.target.value)}
          className="rounded-md border border-zinc-300 px-2 py-1 font-mono dark:border-zinc-700 dark:bg-zinc-950"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-zinc-500">Base URL / tenant (optional)</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={DEFAULTS[kind].baseUrlHint}
          className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
        />
      </label>

      {create.error ? (
        <p className="rounded-md bg-red-100 px-2 py-1 text-xs text-red-900 dark:bg-red-950 dark:text-red-100">
          {create.error.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={create.isPending}
        className="self-start rounded-full bg-zinc-900 px-4 py-1 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
      >
        {create.isPending ? "Creating…" : "Create"}
      </button>
    </form>
  );
}
