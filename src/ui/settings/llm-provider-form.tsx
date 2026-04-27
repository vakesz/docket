"use client";
import { type FormEvent, useId, useState } from "react";
import {
  errorMessageClass,
  fieldClass,
  fieldMonoClass,
  primaryButtonClass,
  settingsPanelClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";

const KINDS = ["openai", "anthropic", "gemini", "bedrock", "mistral", "ollama"] as const;
type Kind = (typeof KINDS)[number];

function parsePrice(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function LlmProviderForm({ canBeDefault }: { canBeDefault: boolean }) {
  const utils = trpc.useUtils();
  const create = trpc.llmProviders.create.useMutation({
    onSuccess: async () => {
      setKind("openai");
      setLabel("");
      setApiKey("");
      setModel("");
      setBaseUrl("");
      setInputPrice("");
      setOutputPrice("");
      setIsDefault(canBeDefault);
      await utils.llmProviders.list.invalidate();
    },
  });

  const kindId = useId();
  const [kind, setKind] = useState<Kind>("openai");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [inputPrice, setInputPrice] = useState("");
  const [outputPrice, setOutputPrice] = useState("");
  const [isDefault, setIsDefault] = useState(canBeDefault);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    create.mutate({
      kind,
      label: label.trim(),
      apiKey: apiKey.trim(),
      model: model.trim(),
      baseUrl: baseUrl.trim(),
      inputPriceCentsPerMtok: parsePrice(inputPrice),
      outputPriceCentsPerMtok: parsePrice(outputPrice),
      isDefault,
    });
  }

  return (
    <form onSubmit={onSubmit} className={`${settingsPanelClass} flex flex-col gap-4 text-sm`}>
      <h2 className="text-base font-medium text-fg">Add LLM provider</h2>

      <div className="flex gap-3">
        <div className="flex w-40 flex-col gap-1">
          <label htmlFor={kindId} className="text-xs text-fg-muted">
            Kind
          </label>
          <SelectField id={kindId} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </SelectField>
        </div>
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
        <p className="text-xs text-fg-muted">
          Stored encrypted at rest. Format depends on the vendor (OpenAI starts with{" "}
          <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">sk-</code>, Anthropic with{" "}
          <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">sk-ant-</code>).
        </p>
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
          <p className="text-xs text-fg-muted">
            Optional override (e.g.{" "}
            <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">gpt-5</code>,{" "}
            <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">claude-sonnet-4-6</code>
            ). Empty lets the adapter pick its default.
          </p>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Base URL (optional)</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className={fieldClass}
          />
          <p className="text-xs text-fg-muted">
            Only set for non-vanilla endpoints — Azure OpenAI, an internal proxy, or a self-hosted
            Ollama. Blank uses the vendor's public endpoint.
          </p>
        </label>
      </div>

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Input price (¢ / Mtok)</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={inputPrice}
            onChange={(e) => setInputPrice(e.target.value)}
            placeholder="200"
            className={fieldClass}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Output price (¢ / Mtok)</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step="any"
            value={outputPrice}
            onChange={(e) => setOutputPrice(e.target.value)}
            placeholder="800"
            className={fieldClass}
          />
        </label>
      </div>
      <p className="-mt-2 text-xs text-fg-muted">
        USD cents per million tokens. Leave blank if unknown — turns will then be logged with no
        cost and budget tracking will undercount. Look up vendor pricing and convert to cents (e.g.
        OpenAI gpt-4.1 input $2 / Mtok = <code className="font-mono">200</code>).
      </p>

      <label className="flex flex-col gap-1">
        <span className="inline-flex items-center gap-2 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
          />
          Make this the global default
        </span>
        <p className="text-xs text-fg-muted">
          Becomes the fallback used by any project that hasn't picked its own LLM. Per-conversation
          overrides still win.
        </p>
      </label>

      {create.error ? <p className={errorMessageClass}>{create.error.message}</p> : null}

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
