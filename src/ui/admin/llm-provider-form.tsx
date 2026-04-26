"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { trpc } from "@/lib/trpc-client";

const KINDS = ["openai", "anthropic", "gemini", "bedrock", "mistral", "ollama"] as const;
type Kind = (typeof KINDS)[number];

export function LlmProviderForm({ canBeDefault }: { canBeDefault: boolean }) {
  const router = useRouter();
  const create = trpc.llmProviders.create.useMutation({
    onSuccess: () => {
      setKind("openai");
      setLabel("");
      setApiKey("");
      setModel("");
      setBaseUrl("");
      setIsDefault(canBeDefault);
      router.refresh();
    },
  });

  const [kind, setKind] = useState<Kind>("openai");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [isDefault, setIsDefault] = useState(canBeDefault);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    create.mutate({
      kind,
      label: label.trim(),
      apiKey: apiKey.trim(),
      model: model.trim(),
      baseUrl: baseUrl.trim(),
      isDefault,
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800"
    >
      <h2 className="text-base font-medium">Add LLM provider</h2>

      <div className="flex gap-2">
        <label className="flex w-40 flex-col gap-1">
          <span className="text-xs text-zinc-500">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
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
            placeholder="OpenAI prod"
            className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-zinc-500">API key</span>
        <input
          required
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          className="rounded-md border border-zinc-300 px-2 py-1 font-mono dark:border-zinc-700 dark:bg-zinc-950"
        />
      </label>

      <div className="flex gap-2">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-zinc-500">Model (optional)</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-5"
            className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-zinc-500">Base URL (optional)</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-400">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
        Make this the global default
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
