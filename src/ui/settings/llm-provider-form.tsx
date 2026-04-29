"use client";
import { Field, Input, Label, Switch } from "@headlessui/react";
import { type FormEvent, useId, useState } from "react";
import { LLM_KIND_LABELS, LLM_KINDS, type LlmKind } from "@/agent/llm/types";
import {
  errorMessageClass,
  fieldClass,
  fieldMonoClass,
  primaryButtonClass,
  settingsPanelClass,
  switchThumbClass,
  switchTrackClass,
  xsBorderButtonClass,
} from "@/lib/form-classes";
import { formatPriceCentsAsDollars, parsePriceDollarsToCents } from "@/lib/pricing";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";

type Kind = LlmKind;
type Role = "chat" | "guardrail";

type EditInitial = {
  id: string;
  kind: string;
  /** Role is stamped at create time and not editable; carried so the form can show it. */
  role: Role;
  label: string;
  model: string;
  baseUrl: string;
  inputPriceCentsPerMtok: number | null;
  outputPriceCentsPerMtok: number | null;
};

type Props =
  /**
   * `defaultRoleAvailability` lets the parent panel disable "Make this the default"
   * when a default already exists for that role. Indexed per role so toggling
   * the role flips the affordance without a re-render dance.
   */
  | {
      mode: "create";
      defaultRoleAvailability: Record<Role, boolean>;
    }
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
    ? (LLM_KINDS as readonly string[]).includes(props.initial.kind)
      ? (props.initial.kind as Kind)
      : "openai"
    : "openai";
  const initialRole: Role = isEdit ? props.initial.role : "chat";

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
  const roleId = useId();
  const [kind, setKind] = useState<Kind>(initialKind);
  const [role, setRole] = useState<Role>(initialRole);
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
  const canBeDefaultForCurrentRole =
    !isEdit && props.mode === "create" ? props.defaultRoleAvailability[role] : false;
  const [isDefault, setIsDefault] = useState(canBeDefaultForCurrentRole);

  function resetCreateFields() {
    setKind("openai");
    setRole("chat");
    setLabel("");
    setApiKey("");
    setModel("");
    setBaseUrl("");
    setInputPrice("");
    setOutputPrice("");
    setIsDefault(props.mode === "create" ? props.defaultRoleAvailability.chat : false);
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
      create.mutate({ ...common, role, isDefault });
    }
  }

  const formClass = isEdit
    ? "flex flex-col gap-3 text-sm"
    : `${settingsPanelClass} flex flex-col gap-4 text-sm`;

  return (
    <form onSubmit={onSubmit} className={formClass}>
      {!isEdit ? <h2 className="text-base font-medium text-foreground">Add LLM provider</h2> : null}

      <div className="flex gap-3">
        <div className="flex w-40 flex-col gap-1">
          <label htmlFor={kindId} className="text-xs text-muted-foreground">
            Kind
          </label>
          <SelectField id={kindId} value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {LLM_KINDS.map((k) => (
              <option key={k} value={k}>
                {LLM_KIND_LABELS[k]}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="flex w-40 flex-col gap-1">
          <label htmlFor={roleId} className="text-xs text-muted-foreground">
            Role
          </label>
          <SelectField
            id={roleId}
            value={role}
            disabled={isEdit}
            onChange={(e) => {
              const next = e.target.value as Role;
              setRole(next);
              if (props.mode === "create") {
                setIsDefault(props.defaultRoleAvailability[next]);
              }
            }}
          >
            <option value="chat">Chat</option>
            <option value="guardrail">Guardrail</option>
          </SelectField>
        </div>
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Label</Label>
          <Input
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={role === "guardrail" ? "OpenAI guardrail" : "OpenAI prod"}
            className={fieldClass}
          />
        </Field>
      </div>
      {!isEdit ? (
        <p className="-mt-2 text-xs text-muted-foreground">
          {role === "chat"
            ? "Chat rows feed the agent loop. The conversation LLM picker only sees chat rows."
            : "Guardrail rows feed the prompt-injection / topic-scope / output-safety classifier. They run alongside chat — never as the chat model. A small / cheap model is recommended (e.g. gpt-5-nano)."}
        </p>
      ) : null}

      <Field className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">
          {isEdit ? "API key (leave blank to keep current)" : "API key"}
        </Label>
        <Input
          required={!isEdit}
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-..."
          className={fieldMonoClass}
        />
        <p className="text-xs text-muted-foreground">
          {isEdit ? (
            "Stored encrypted at rest. Only fill this in to rotate the key."
          ) : (
            <>
              Stored encrypted at rest. Format depends on the vendor (OpenAI starts with{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">sk-</code>, Anthropic with{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono">sk-ant-</code>).
            </>
          )}
        </p>
      </Field>

      <div className="flex gap-3">
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-muted-foreground">
            {isEdit ? "Model" : "Model (optional)"}
          </Label>
          <Input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-5"
            className={fieldClass}
          />
          <p className="text-xs text-muted-foreground">
            {isEdit ? (
              "Optional override. Empty lets the adapter pick its default."
            ) : (
              <>
                Optional override (e.g.{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">gpt-5</code>,{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">claude-sonnet-4-6</code>
                ). Empty lets the adapter pick its default.
              </>
            )}
          </p>
        </Field>
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-muted-foreground">
            {isEdit ? "Base URL" : "Base URL (optional)"}
          </Label>
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className={fieldClass}
          />
          <p className="text-xs text-muted-foreground">
            Only set for non-vanilla endpoints — Azure OpenAI, an internal proxy, or a self-hosted
            Ollama. Blank uses the vendor's public endpoint.
          </p>
        </Field>
      </div>

      <div className="flex gap-3">
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Input price ($ / Mtok)</Label>
          <Input
            type="text"
            inputMode="decimal"
            value={inputPrice}
            onChange={(e) => setInputPrice(e.target.value)}
            placeholder="2.00"
            className={fieldClass}
          />
        </Field>
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-muted-foreground">Output price ($ / Mtok)</Label>
          <Input
            type="text"
            inputMode="decimal"
            value={outputPrice}
            onChange={(e) => setOutputPrice(e.target.value)}
            placeholder="8.00"
            className={fieldClass}
          />
        </Field>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">
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
          <Field className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={isDefault} onChange={setIsDefault} className={switchTrackClass}>
              <span aria-hidden className={switchThumbClass} />
            </Switch>
            <Label>Make this the {role === "guardrail" ? "guardrail" : "chat"} default</Label>
          </Field>
          <p className="text-xs text-muted-foreground">
            {role === "guardrail"
              ? "Becomes the fallback used by any project that hasn't pinned its own guardrail row. The pattern guardrail still runs first regardless."
              : "Becomes the fallback used by any project that hasn't picked its own chat LLM. Per-conversation overrides still win."}
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
