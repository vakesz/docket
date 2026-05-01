"use client";

import { useId } from "react";
import { LLM_KIND_LABELS, LLM_KIND_META, LLM_KINDS, type LlmKind } from "@/agent/llm/types";
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

export type LlmRole = "chat" | "guardrail";

export type LlmStepState = {
  enabled: boolean;
  kind: LlmKind;
  role: LlmRole;
  label: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  inputPrice: string;
  outputPrice: string;
};

export type LlmStepHandlers = {
  setEnabled: (next: boolean) => void;
  setKind: (next: LlmKind) => void;
  setRole: (next: LlmRole) => void;
  setLabel: (next: string) => void;
  setApiKey: (next: string) => void;
  setModel: (next: string) => void;
  setBaseUrl: (next: string) => void;
  setInputPrice: (next: string) => void;
  setOutputPrice: (next: string) => void;
};

/**
 * Generic LLM step. The wizard renders one of these per "draft" — drafts
 * can be added/removed via the wizard's "+ Add another LLM" affordance.
 * All vendor-specific copy comes from `LLM_KIND_META`; the kind picker is
 * hidden when `LLM_KINDS` only contains one entry.
 */
export function StepLlm({
  state,
  handlers,
  alreadyConfigured,
  index,
  onRemove,
}: {
  state: LlmStepState;
  handlers: LlmStepHandlers;
  /**
   * Whether the deployment already has a row for this draft's current
   * (kind, role). The toggle goes disabled+`configured` when true so the
   * operator can tell that submitting again won't create a duplicate.
   */
  alreadyConfigured: boolean;
  /** 1-based index used in the section title when more than one draft is present. */
  index?: number;
  /** Optional remove button shown next to the toggle. Hidden when there's only one draft. */
  onRemove?: () => void;
}) {
  const meta = LLM_KIND_META[state.kind];
  const heading =
    typeof index === "number" ? `LLM provider #${index}` : LLM_KIND_LABELS[state.kind];
  const kindId = useId();
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
      {meta.foundryHint ? (
        <Alert variant="warning">
          <AlertTitle>{meta.foundryHint.title}</AlertTitle>
          <AlertDescription>{meta.foundryHint.body}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex gap-3">
        {LLM_KINDS.length > 1 ? (
          <div className="flex w-40 flex-col gap-1">
            <Label htmlFor={kindId} className="text-muted-foreground text-xs">
              Kind
            </Label>
            <Select value={state.kind} onValueChange={(next) => handlers.setKind(next as LlmKind)}>
              <SelectTrigger id={kindId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LLM_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {LLM_KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="flex w-40 flex-col gap-1">
          <Label htmlFor={roleId} className="text-muted-foreground text-xs">
            Role
          </Label>
          <Select value={state.role} onValueChange={(next) => handlers.setRole(next as LlmRole)}>
            <SelectTrigger id={roleId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="chat">Chat</SelectItem>
              <SelectItem value="guardrail">Guardrail</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={labelInputId} className="text-muted-foreground text-xs">
            Display label
          </Label>
          <Input
            id={labelInputId}
            value={state.label}
            onChange={(e) => handlers.setLabel(e.target.value)}
            placeholder={
              state.role === "guardrail"
                ? meta.defaultLabelByRole.guardrail
                : meta.defaultLabelByRole.chat
            }
            autoComplete="off"
            required={state.enabled}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={apiKeyId} className="text-muted-foreground text-xs">
          API key
        </Label>
        <Input
          id={apiKeyId}
          type="password"
          value={state.apiKey}
          onChange={(e) => handlers.setApiKey(e.target.value)}
          placeholder={meta.apiKeyPlaceholder}
          className="font-mono"
          autoComplete="off"
          required={state.enabled}
        />
        <p className="text-muted-foreground/70 text-xs">
          {meta.apiKeyHelp} Stored AES-GCM encrypted.
        </p>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={modelId} className="text-muted-foreground text-xs">
            Model
          </Label>
          <Input
            id={modelId}
            value={state.model}
            onChange={(e) => handlers.setModel(e.target.value)}
            placeholder={
              state.role === "guardrail"
                ? meta.defaultModelByRole.guardrail
                : meta.defaultModelByRole.chat
            }
            list={modelListId}
            className="font-mono"
            autoComplete="off"
            required={state.enabled}
          />
          <datalist id={modelListId}>
            {meta.modelSuggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <p className="text-muted-foreground/70 text-xs">
            {state.role === "guardrail"
              ? "Pick a small / cheap model — guardrail runs on every turn."
              : meta.modelHelp}
          </p>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={baseUrlId} className="text-muted-foreground text-xs">
            Base URL (optional)
          </Label>
          <Input
            id={baseUrlId}
            value={state.baseUrl}
            onChange={(e) => handlers.setBaseUrl(e.target.value)}
            placeholder={meta.baseUrlPlaceholder}
            autoComplete="off"
          />
          <p className="text-muted-foreground/70 text-xs">{meta.baseUrlHelp}</p>
        </div>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={inputPriceId} className="text-muted-foreground text-xs">
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
          <Label htmlFor={outputPriceId} className="text-muted-foreground text-xs">
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
      <p className="-mt-2 text-muted-foreground/70 text-xs">
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
