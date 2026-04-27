"use client";

import { fieldClass, fieldMonoClass } from "@/lib/form-classes";
import { ProviderToggle } from "@/ui/setup/provider-toggle";

const OPENAI_MODEL_SUGGESTIONS = [
  "gpt-5",
  "gpt-5-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
] as const;

export type OpenaiStepState = {
  enabled: boolean;
  label: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  inputPrice: string;
  outputPrice: string;
};

export type OpenaiStepHandlers = {
  setEnabled: (next: boolean) => void;
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
}: {
  state: OpenaiStepState;
  handlers: OpenaiStepHandlers;
  alreadyConfigured: boolean;
}) {
  return (
    <ProviderToggle
      label="OpenAI (or OpenAI-compatible)"
      checked={state.enabled}
      disabled={alreadyConfigured}
      alreadyConfigured={alreadyConfigured}
      onChange={handlers.setEnabled}
      help={null}
    >
      <aside
        role="note"
        className="rounded-2xl border border-warning/40 bg-warning-bg/40 p-4 text-xs text-warning-fg"
      >
        <p className="mb-1 font-medium">Adding an Azure AI Foundry model</p>
        <p>
          Use the project&rsquo;s OpenAI v1 endpoint as the Base URL — the path must end with{" "}
          <code className="rounded bg-surface px-1 py-0.5 font-mono text-fg">/openai/v1/</code>. Set{" "}
          <span className="font-medium">Model</span> to the deployment name shown in Foundry &rarr;
          Model deployments (for example <code className="font-mono">gpt-5</code>).
        </p>
        <p className="mt-2">Template:</p>
        <code className="mt-1 block break-all rounded bg-surface px-2 py-1 font-mono text-[0.7rem] leading-snug text-fg">
          https://&lt;resource&gt;.services.ai.azure.com/api/projects/&lt;project&gt;/openai/v1/
        </code>
      </aside>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-fg-muted">Display label</span>
        <input
          value={state.label}
          onChange={(e) => handlers.setLabel(e.target.value)}
          placeholder="OpenAI"
          className={fieldClass}
          autoComplete="off"
          required={state.enabled}
        />
        <p className="text-xs text-fg-faint">
          Shown in the model picker. Useful if you'll add multiple OpenAI-compatible endpoints.
        </p>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-fg-muted">API key</span>
        <input
          type="password"
          value={state.apiKey}
          onChange={(e) => handlers.setApiKey(e.target.value)}
          placeholder="sk-proj-aBc1234567890dEfGhIjKlMnOpQrStUvWxYz"
          className={fieldMonoClass}
          autoComplete="off"
          required={state.enabled}
        />
        <p className="text-xs text-fg-faint">
          OpenAI keys start with <code className="font-mono">sk-</code> /{" "}
          <code className="font-mono">sk-proj-</code>. Stored AES-GCM encrypted.
        </p>
      </label>

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Model</span>
          <input
            value={state.model}
            onChange={(e) => handlers.setModel(e.target.value)}
            placeholder="gpt-5"
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
          <p className="text-xs text-fg-faint">
            Pick a suggestion or type any deployment name (Azure Foundry users — paste your
            deployment id).
          </p>
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Base URL (optional)</span>
          <input
            value={state.baseUrl}
            onChange={(e) => handlers.setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className={fieldClass}
            autoComplete="off"
          />
          <p className="text-xs text-fg-faint">
            Blank uses OpenAI's public endpoint. Set for Azure OpenAI / Foundry / Ollama / a proxy.
          </p>
        </label>
      </div>

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Input price ($ / Mtok)</span>
          <input
            type="text"
            inputMode="decimal"
            value={state.inputPrice}
            onChange={(e) => handlers.setInputPrice(e.target.value)}
            placeholder="2.00"
            className={fieldClass}
            autoComplete="off"
          />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Output price ($ / Mtok)</span>
          <input
            type="text"
            inputMode="decimal"
            value={state.outputPrice}
            onChange={(e) => handlers.setOutputPrice(e.target.value)}
            placeholder="8.00"
            className={fieldClass}
            autoComplete="off"
          />
        </label>
      </div>
      <p className="-mt-2 text-xs text-fg-faint">
        USD per million tokens — paste the vendor's published rate as-is. Leave blank if unknown;
        budget tracking will undercount until you fill them in from{" "}
        <code className="font-mono">/settings</code>.
      </p>
    </ProviderToggle>
  );
}
