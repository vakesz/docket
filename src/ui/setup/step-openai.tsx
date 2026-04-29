"use client";

import { Field, Input, Label } from "@headlessui/react";
import { fieldClass, fieldMonoClass, xsBorderButtonClass } from "@/lib/form-classes";
import { SelectField } from "@/ui/forms/select-field";
import { ProviderToggle } from "@/ui/setup/provider-toggle";

const OPENAI_MODEL_SUGGESTIONS = [
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
] as const;

export type OpenaiRole = "chat" | "guardrail";

export type OpenaiStepState = {
  enabled: boolean;
  role: OpenaiRole;
  label: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  inputPrice: string;
  outputPrice: string;
};

export type OpenaiStepHandlers = {
  setEnabled: (next: boolean) => void;
  setRole: (next: OpenaiRole) => void;
  setLabel: (next: string) => void;
  setApiKey: (next: string) => void;
  setModel: (next: string) => void;
  setBaseUrl: (next: string) => void;
  setInputPrice: (next: string) => void;
  setOutputPrice: (next: string) => void;
};

export function StepOpenai({
  state,
  handlers,
  alreadyConfigured,
  index,
  onRemove,
}: {
  state: OpenaiStepState;
  handlers: OpenaiStepHandlers;
  /**
   * Whether the deployment already has a row for this draft's current role.
   * The toggle goes disabled+`configured` when true so the operator can
   * tell that submitting again won't create a duplicate.
   */
  alreadyConfigured: boolean;
  /** 1-based index used in the section title when more than one draft is present. */
  index?: number;
  /** Optional remove button shown next to the toggle. Hidden when there's only one draft. */
  onRemove?: () => void;
}) {
  const heading =
    typeof index === "number" ? `OpenAI provider #${index}` : "OpenAI (or OpenAI-compatible)";
  return (
    <ProviderToggle
      label={heading}
      checked={state.enabled}
      disabled={alreadyConfigured}
      alreadyConfigured={alreadyConfigured}
      onChange={handlers.setEnabled}
      help={
        state.role === "guardrail"
          ? "Guardrail row — feeds the prompt-injection / topic-scope classifier."
          : "Chat row — feeds the agent loop."
      }
    >
      <aside
        role="note"
        className="rounded-2xl border border-warning/40 bg-warning/10 p-4 text-xs text-warning"
      >
        <p className="mb-1 font-medium">Adding an Azure AI Foundry model</p>
        <p>
          Use the project&rsquo;s OpenAI v1 endpoint as the Base URL — the path must end with{" "}
          <code className="rounded bg-card px-1 py-0.5 font-mono text-foreground">/openai/v1/</code>
          . Set <span className="font-medium">Model</span> to the deployment name shown in Foundry
          &rarr; Model deployments (for example <code className="font-mono">gpt-5</code>).
        </p>
        <p className="mt-2">Template:</p>
        <code className="mt-1 block break-all rounded bg-card px-2 py-1 font-mono text-[0.7rem] leading-snug text-foreground">
          https://&lt;resource&gt;.services.ai.azure.com/api/projects/&lt;project&gt;/openai/v1/
        </code>
      </aside>

      <div className="flex gap-3">
        <Field className="flex w-40 flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Role</Label>
          <SelectField
            value={state.role}
            onChange={(e) => handlers.setRole(e.target.value as OpenaiRole)}
          >
            <option value="chat">Chat</option>
            <option value="guardrail">Guardrail</option>
          </SelectField>
          <p className="text-xs text-muted-foreground-faint">
            Stamped at create — switch in /settings means delete + recreate.
          </p>
        </Field>
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Display label</Label>
          <Input
            value={state.label}
            onChange={(e) => handlers.setLabel(e.target.value)}
            placeholder={state.role === "guardrail" ? "OpenAI guardrail" : "OpenAI"}
            className={fieldClass}
            autoComplete="off"
            required={state.enabled}
          />
          <p className="text-xs text-muted-foreground-faint">
            Shown in the model picker. Useful if you'll add multiple OpenAI-compatible endpoints.
          </p>
        </Field>
      </div>

      <Field className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">API key</Label>
        <Input
          type="password"
          value={state.apiKey}
          onChange={(e) => handlers.setApiKey(e.target.value)}
          placeholder="sk-proj-aBc1234567890dEfGhIjKlMnOpQrStUvWxYz"
          className={fieldMonoClass}
          autoComplete="off"
          required={state.enabled}
        />
        <p className="text-xs text-muted-foreground-faint">
          OpenAI keys start with <code className="font-mono">sk-</code> /{" "}
          <code className="font-mono">sk-proj-</code>. Stored AES-GCM encrypted.
        </p>
      </Field>

      <div className="flex gap-3">
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Model</Label>
          <Input
            value={state.model}
            onChange={(e) => handlers.setModel(e.target.value)}
            placeholder={state.role === "guardrail" ? "gpt-5-nano" : "gpt-5"}
            list="setup-openai-models"
            className={fieldMonoClass}
            autoComplete="off"
            required={state.enabled}
          />
          <datalist id="setup-openai-models">
            {OPENAI_MODEL_SUGGESTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <p className="text-xs text-muted-foreground-faint">
            {state.role === "guardrail"
              ? "Pick a small / cheap model — guardrail runs on every turn."
              : "Pick a suggestion or type any deployment name (Azure Foundry users — paste your deployment id)."}
          </p>
        </Field>
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Base URL (optional)</Label>
          <Input
            value={state.baseUrl}
            onChange={(e) => handlers.setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className={fieldClass}
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground-faint">
            Blank uses OpenAI's public endpoint. Set for Azure OpenAI / Foundry / Ollama / a proxy.
          </p>
        </Field>
      </div>

      <div className="flex gap-3">
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Input price ($ / Mtok)</Label>
          <Input
            type="text"
            inputMode="decimal"
            value={state.inputPrice}
            onChange={(e) => handlers.setInputPrice(e.target.value)}
            placeholder="2.00"
            className={fieldClass}
            autoComplete="off"
          />
        </Field>
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Output price ($ / Mtok)</Label>
          <Input
            type="text"
            inputMode="decimal"
            value={state.outputPrice}
            onChange={(e) => handlers.setOutputPrice(e.target.value)}
            placeholder="8.00"
            className={fieldClass}
            autoComplete="off"
          />
        </Field>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground-faint">
        USD per million tokens — paste the vendor's published rate as-is. Leave blank if unknown;
        budget tracking will undercount until you fill them in from{" "}
        <code className="font-mono">/settings</code>.
      </p>

      {onRemove ? (
        <button type="button" onClick={onRemove} className={`${xsBorderButtonClass} self-start`}>
          Remove this provider
        </button>
      ) : null}
    </ProviderToggle>
  );
}
