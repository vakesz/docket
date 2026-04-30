"use client";

import { useId } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";
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
  const roleId = useId();
  const labelInputId = useId();
  const apiKeyId = useId();
  const modelId = useId();
  const baseUrlId = useId();
  const inputPriceId = useId();
  const outputPriceId = useId();
  const modelListId = useId();

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
      <Alert variant="warning">
        <AlertTitle>Adding an Azure AI Foundry model</AlertTitle>
        <AlertDescription>
          <p>
            Use the project&rsquo;s OpenAI v1 endpoint as the Base URL — the path must end with{" "}
            <code className="rounded bg-card px-1 py-0.5 font-mono text-foreground">
              /openai/v1/
            </code>
            . Set <span className="font-medium">Model</span> to the deployment name shown in Foundry
            &rarr; Model deployments (for example <code className="font-mono">gpt-5</code>).
          </p>
          <p className="mt-2">Template:</p>
          <code className="mt-1 block break-all rounded bg-card px-2 py-1 font-mono text-[0.7rem] leading-snug text-foreground">
            https://&lt;resource&gt;.services.ai.azure.com/api/projects/&lt;project&gt;/openai/v1/
          </code>
        </AlertDescription>
      </Alert>

      <div className="flex gap-3">
        <div className="flex w-40 flex-col gap-1">
          <Label htmlFor={roleId} className="text-xs text-muted-foreground">
            Role
          </Label>
          <Select value={state.role} onValueChange={(next) => handlers.setRole(next as OpenaiRole)}>
            <SelectTrigger id={roleId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="chat">Chat</SelectItem>
              <SelectItem value="guardrail">Guardrail</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground/70">
            Stamped at create — switch in /settings means delete + recreate.
          </p>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={labelInputId} className="text-xs text-muted-foreground">
            Display label
          </Label>
          <Input
            id={labelInputId}
            value={state.label}
            onChange={(e) => handlers.setLabel(e.target.value)}
            placeholder={state.role === "guardrail" ? "OpenAI guardrail" : "OpenAI"}
            autoComplete="off"
            required={state.enabled}
          />
          <p className="text-xs text-muted-foreground/70">
            Shown in the model picker. Useful if you'll add multiple OpenAI-compatible endpoints.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={apiKeyId} className="text-xs text-muted-foreground">
          API key
        </Label>
        <Input
          id={apiKeyId}
          type="password"
          value={state.apiKey}
          onChange={(e) => handlers.setApiKey(e.target.value)}
          placeholder="sk-proj-aBc1234567890dEfGhIjKlMnOpQrStUvWxYz"
          className="font-mono"
          autoComplete="off"
          required={state.enabled}
        />
        <p className="text-xs text-muted-foreground/70">
          OpenAI keys start with <code className="font-mono">sk-</code> /{" "}
          <code className="font-mono">sk-proj-</code>. Stored AES-GCM encrypted.
        </p>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={modelId} className="text-xs text-muted-foreground">
            Model
          </Label>
          <Input
            id={modelId}
            value={state.model}
            onChange={(e) => handlers.setModel(e.target.value)}
            placeholder={state.role === "guardrail" ? "gpt-5-nano" : "gpt-5"}
            list={modelListId}
            className="font-mono"
            autoComplete="off"
            required={state.enabled}
          />
          <datalist id={modelListId}>
            {OPENAI_MODEL_SUGGESTIONS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <p className="text-xs text-muted-foreground/70">
            {state.role === "guardrail"
              ? "Pick a small / cheap model — guardrail runs on every turn."
              : "Pick a suggestion or type any deployment name (Azure Foundry users — paste your deployment id)."}
          </p>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={baseUrlId} className="text-xs text-muted-foreground">
            Base URL (optional)
          </Label>
          <Input
            id={baseUrlId}
            value={state.baseUrl}
            onChange={(e) => handlers.setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground/70">
            Blank uses OpenAI's public endpoint. Set for Azure OpenAI / Foundry / Ollama / a proxy.
          </p>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={inputPriceId} className="text-xs text-muted-foreground">
            Input price ($ / Mtok)
          </Label>
          <Input
            id={inputPriceId}
            type="text"
            inputMode="decimal"
            value={state.inputPrice}
            onChange={(e) => handlers.setInputPrice(e.target.value)}
            placeholder="2.00"
            autoComplete="off"
          />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={outputPriceId} className="text-xs text-muted-foreground">
            Output price ($ / Mtok)
          </Label>
          <Input
            id={outputPriceId}
            type="text"
            inputMode="decimal"
            value={state.outputPrice}
            onChange={(e) => handlers.setOutputPrice(e.target.value)}
            placeholder="8.00"
            autoComplete="off"
          />
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground/70">
        USD per million tokens — paste the vendor's published rate as-is. Leave blank if unknown;
        budget tracking will undercount until you fill them in from{" "}
        <code className="font-mono">/settings</code>.
      </p>

      {onRemove ? (
        <Button type="button" variant="outline" size="xs" onClick={onRemove} className="self-start">
          Remove this provider
        </Button>
      ) : null}
    </ProviderToggle>
  );
}
