"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import {
  fieldClass,
  fieldMonoClass,
  primaryButtonClass,
  settingsPanelClass,
} from "@/lib/form-classes";
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
    <form onSubmit={onSubmit} className={`${settingsPanelClass} flex flex-col gap-4 text-sm`}>
      <h2 className="text-base font-medium text-fg">Add LLM provider</h2>

      <div className="flex gap-3">
        <label className="flex w-40 flex-col gap-1">
          <span className="text-xs text-fg-muted">Kind</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as Kind)}
            className={fieldClass}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Label</span>
          <input
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="OpenAI prod"
            className={fieldClass}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-fg-muted">API key</span>
        <input
          required
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          className={fieldMonoClass}
        />
      </label>

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Model (optional)</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-5"
            className={fieldClass}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Base URL (optional)</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className={fieldClass}
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-xs text-fg-muted">
        <input
          type="checkbox"
          checked={isDefault}
          onChange={(e) => setIsDefault(e.target.checked)}
        />
        Make this the global default
      </label>

      {create.error ? (
        <p className="rounded-md border border-danger/40 bg-danger-bg/40 px-2 py-1 text-xs text-danger-fg">
          {create.error.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={create.isPending}
        className={`${primaryButtonClass} self-start`}
      >
        {create.isPending ? "Creating…" : "Create"}
      </button>
    </form>
  );
}
