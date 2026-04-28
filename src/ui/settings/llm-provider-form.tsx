"use client";
import { type FormEvent, useId, useState } from "react";
import {
  errorMessageClass,
  fieldClass,
  fieldMonoClass,
  primaryButtonClass,
  settingsPanelClass,
  xsBorderButtonClass,
} from "@/lib/form-classes";
import { formatPriceCentsAsDollars, parsePriceDollarsToCents } from "@/lib/pricing";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";
import { Toggle } from "@/ui/primitives/toggle";

const KINDS = ["openai", "anthropic", "gemini", "bedrock", "mistral", "ollama"] as const;
type Kind = (typeof KINDS)[number];

type EditInitial = {
  id: string;
  kind: string;
  label: string;
  model: string;
  baseUrl: string;
  inputPriceCentsPerMtok: number | null;
  outputPriceCentsPerMtok: number | null;
};

type Props =
  | { mode: "create"; canBeDefault: boolean }
  | { mode: "edit"; initial: EditInitial; onClose: () => void };

/**
 * Single LLM-provider form serving both the "add" panel and the inline
 * "edit" view in `llm-providers-panel.tsx`. The two only diverge on:
 *   - which mutation runs (create vs update),
 *   - whether the API key is required (create) or optional rotation (edit),
 *   - whether the "make default" checkbox is shown (create only),
 *   - the chrome around the form (create wraps in `settingsPanelClass`;
 *     edit renders bare so the panel row owns the border).
 */
export function LlmProviderForm(props: Props) {
  const utils = trpc.useUtils();
  const isEdit = props.mode === "edit";

  const initialKind: Kind = isEdit
    ? KINDS.includes(props.initial.kind as Kind)
      ? (props.initial.kind as Kind)
      : "openai"
    : "openai";

  const create = trpc.llmProviders.create.useMutation({
    onSuccess: async () => {
      resetCreateFields();
      await utils.llmProviders.list.invalidate();
    },
  });
  const update = trpc.llmProviders.update.useMutation({
    onSuccess: async () => {
      await utils.llmProviders.list.invalidate();
      if (isEdit) props.onClose();
    },
  });
  const mutation = isEdit ? update : create;

  const kindId = useId();
  const [kind, setKind] = useState<Kind>(initialKind);
  const [label, setLabel] = useState(isEdit ? props.initial.label : "");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState(isEdit ? props.initial.model : "");
  const [baseUrl, setBaseUrl] = useState(isEdit ? props.initial.baseUrl : "");
  const [inputPrice, setInputPrice] = useState(
    isEdit ? formatPriceCentsAsDollars(props.initial.inputPriceCentsPerMtok) : "",
  );
  const [outputPrice, setOutputPrice] = useState(
    isEdit ? formatPriceCentsAsDollars(props.initial.outputPriceCentsPerMtok) : "",
  );
  const [isDefault, setIsDefault] = useState(
    !isEdit && props.mode === "create" && props.canBeDefault,
  );

  function resetCreateFields() {
    setKind("openai");
    setLabel("");
    setApiKey("");
    setModel("");
    setBaseUrl("");
    setInputPrice("");
    setOutputPrice("");
    setIsDefault(props.mode === "create" && props.canBeDefault);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const common = {
      kind,
      label: label.trim(),
      apiKey: apiKey.trim(),
      model: model.trim(),
      baseUrl: baseUrl.trim(),
      inputPriceCentsPerMtok: parsePriceDollarsToCents(inputPrice),
      outputPriceCentsPerMtok: parsePriceDollarsToCents(outputPrice),
    };
    if (props.mode === "edit") {
      update.mutate({ id: props.initial.id, ...common });
    } else {
      create.mutate({ ...common, isDefault });
    }
  }

  const formClass = isEdit
    ? "flex flex-col gap-3 text-sm"
    : `${settingsPanelClass} flex flex-col gap-4 text-sm`;

  return (
    <form onSubmit={onSubmit} className={formClass}>
      {!isEdit ? <h2 className="text-base font-medium text-fg">Add LLM provider</h2> : null}

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
        <span className="text-xs text-fg-muted">
          {isEdit ? "API key (leave blank to keep current)" : "API key"}
        </span>
        <input
          required={!isEdit}
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          className={fieldMonoClass}
        />
        <p className="text-xs text-fg-muted">
          {isEdit ? (
            "Stored encrypted at rest. Only fill this in to rotate the key."
          ) : (
            <>
              Stored encrypted at rest. Format depends on the vendor (OpenAI starts with{" "}
              <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">sk-</code>, Anthropic
              with <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">sk-ant-</code>).
            </>
          )}
        </p>
      </label>

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">{isEdit ? "Model" : "Model (optional)"}</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-5"
            className={fieldClass}
          />
          <p className="text-xs text-fg-muted">
            {isEdit ? (
              "Optional override. Empty lets the adapter pick its default."
            ) : (
              <>
                Optional override (e.g.{" "}
                <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">gpt-5</code>,{" "}
                <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">
                  claude-sonnet-4-6
                </code>
                ). Empty lets the adapter pick its default.
              </>
            )}
          </p>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">
            {isEdit ? "Base URL" : "Base URL (optional)"}
          </span>
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
        USD per million tokens — paste the vendor's published rate as-is
        {isEdit
          ? ". Leave blank if unknown — turns will then be logged with no cost and budget tracking will undercount."
          : " (e.g. OpenAI gpt-4.1 is "}
        {!isEdit ? (
          <>
            <code className="font-mono">2.00</code> in / <code className="font-mono">8.00</code>{" "}
            out). Leave blank if unknown — turns will then be logged with no cost and budget
            tracking will undercount.
          </>
        ) : null}
      </p>

      {!isEdit ? (
        <div className="flex flex-col gap-1">
          <Toggle
            inline
            size="muted"
            checked={isDefault}
            onChange={setIsDefault}
            label="Make this the global default"
          />
          <p className="text-xs text-fg-muted">
            Becomes the fallback used by any project that hasn't picked its own LLM.
            Per-conversation overrides still win.
          </p>
        </div>
      ) : null}

      {mutation.error ? <p className={errorMessageClass}>{mutation.error.message}</p> : null}

      {isEdit ? (
        <div className="flex items-center gap-2">
          <button type="submit" disabled={mutation.isPending} className={primaryButtonClass}>
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={props.onClose}
            disabled={mutation.isPending}
            className={xsBorderButtonClass}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="submit"
          disabled={mutation.isPending}
          className={`${primaryButtonClass} self-start`}
        >
          {mutation.isPending ? "Creating…" : "Create"}
        </button>
      )}
    </form>
  );
}
