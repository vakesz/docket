"use client";
import { type FormEvent, useId, useState } from "react";
import {
  errorMessageClass,
  fieldClass,
  fieldMonoClass,
  primaryButtonClass,
  xsBorderButtonClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";

const KINDS = ["openai", "anthropic", "gemini", "bedrock", "mistral", "ollama"] as const;
type Kind = (typeof KINDS)[number];

/**
 * Parse "$ per Mtok" form input into cents-per-Mtok for the router.
 * Accepts both "1.25" and "1,25" — the comma is the decimal separator in
 * many European locales and would otherwise silently parse as NaN → null.
 */
function parsePriceDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed.length === 0) return null;
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

/** Render a stored cents-per-Mtok value as a dollar string for the form. */
function formatPriceCentsAsDollars(cents: number | null | undefined): string {
  if (typeof cents !== "number") return "";
  // Two decimal places is plenty — vendors quote at the cent today (e.g. $0.05).
  return (cents / 100).toFixed(2);
}

type Initial = {
  id: string;
  kind: string;
  label: string;
  model: string;
  baseUrl: string;
  inputPriceCentsPerMtok: number | null;
  outputPriceCentsPerMtok: number | null;
};

export function LlmProviderEditForm({
  initial,
  onClose,
}: {
  initial: Initial;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const update = trpc.llmProviders.update.useMutation({
    onSuccess: async () => {
      await utils.llmProviders.list.invalidate();
      onClose();
    },
  });

  const kindId = useId();
  const [kind, setKind] = useState<Kind>(
    KINDS.includes(initial.kind as Kind) ? (initial.kind as Kind) : "openai",
  );
  const [label, setLabel] = useState(initial.label);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(initial.model);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  const [inputPrice, setInputPrice] = useState(
    formatPriceCentsAsDollars(initial.inputPriceCentsPerMtok),
  );
  const [outputPrice, setOutputPrice] = useState(
    formatPriceCentsAsDollars(initial.outputPriceCentsPerMtok),
  );

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    update.mutate({
      id: initial.id,
      kind,
      label: label.trim(),
      apiKey: apiKey.trim(),
      model: model.trim(),
      baseUrl: baseUrl.trim(),
      inputPriceCentsPerMtok: parsePriceDollarsToCents(inputPrice),
      outputPriceCentsPerMtok: parsePriceDollarsToCents(outputPrice),
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 text-sm">
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
            className={fieldClass}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-fg-muted">API key (leave blank to keep current)</span>
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          className={fieldMonoClass}
        />
        <p className="text-xs text-fg-muted">
          Stored encrypted at rest. Only fill this in to rotate the key.
        </p>
      </label>

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-5"
            className={fieldClass}
          />
          <p className="text-xs text-fg-muted">
            Optional override. Empty lets the adapter pick its default.
          </p>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Base URL</span>
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
          <span className="text-xs text-fg-muted">Input price ($ / Mtok)</span>
          <input
            type="text"
            inputMode="decimal"
            value={inputPrice}
            onChange={(e) => setInputPrice(e.target.value)}
            placeholder="2.00"
            className={fieldClass}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Output price ($ / Mtok)</span>
          <input
            type="text"
            inputMode="decimal"
            value={outputPrice}
            onChange={(e) => setOutputPrice(e.target.value)}
            placeholder="8.00"
            className={fieldClass}
          />
        </label>
      </div>
      <p className="-mt-2 text-xs text-fg-muted">
        USD per million tokens — paste the vendor's published rate as-is. Leave blank if unknown —
        turns will then be logged with no cost and budget tracking will undercount.
      </p>

      {update.error ? <p className={errorMessageClass}>{update.error.message}</p> : null}

      <div className="flex items-center gap-2">
        <button type="submit" disabled={update.isPending} className={primaryButtonClass}>
          {update.isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={update.isPending}
          className={xsBorderButtonClass}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
