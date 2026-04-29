"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { LLM_KIND_LABELS, LLM_KINDS, type LlmKind } from "@/agent/llm/types";
import { formatPriceCentsAsDollars, parsePriceDollarsToCents } from "@/lib/pricing";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/ui/primitives/form";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";
import { Switch } from "@/ui/primitives/switch";

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

const formSchema = z.object({
  kind: z.enum(LLM_KINDS),
  role: z.enum(["chat", "guardrail"]),
  label: z.string().trim().min(1, "Label is required"),
  apiKey: z.string(),
  model: z.string().trim(),
  baseUrl: z.string().trim(),
  inputPrice: z.string().trim(),
  outputPrice: z.string().trim(),
  isDefault: z.boolean(),
});

type FormValues = z.infer<typeof formSchema>;

/**
 * Single LLM-provider form serving both the "add" panel and the inline
 * "edit" view in `llm-providers-panel.tsx`. The two only diverge on:
 *   - which mutation runs (create vs update),
 *   - whether the API key is required (create) or optional rotation (edit),
 *   - whether the "make default" checkbox is shown (create only),
 *   - the chrome around the form (create wraps in a card; edit renders bare).
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
      form.reset(defaultValues);
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

  const canBeDefaultForCurrentRole =
    !isEdit && props.mode === "create" ? props.defaultRoleAvailability[initialRole] : false;

  const defaultValues: FormValues = {
    kind: initialKind,
    role: initialRole,
    label: isEdit ? props.initial.label : "",
    apiKey: "",
    model: isEdit ? props.initial.model : "",
    baseUrl: isEdit ? props.initial.baseUrl : "",
    inputPrice: isEdit ? formatPriceCentsAsDollars(props.initial.inputPriceCentsPerMtok) : "",
    outputPrice: isEdit ? formatPriceCentsAsDollars(props.initial.outputPriceCentsPerMtok) : "",
    isDefault: canBeDefaultForCurrentRole,
  };

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues,
  });

  const role = form.watch("role");

  function onSubmit(values: FormValues) {
    if (!isEdit && values.apiKey.trim() === "") {
      form.setError("apiKey", { message: "API key is required" });
      return;
    }
    const common = {
      kind: values.kind,
      label: values.label.trim(),
      apiKey: values.apiKey.trim(),
      model: values.model.trim(),
      baseUrl: values.baseUrl.trim(),
      inputPriceCentsPerMtok: parsePriceDollarsToCents(values.inputPrice),
      outputPriceCentsPerMtok: parsePriceDollarsToCents(values.outputPrice),
    };
    if (props.mode === "edit") {
      update.mutate({ id: props.initial.id, ...common });
    } else {
      create.mutate({ ...common, role: values.role, isDefault: values.isDefault });
    }
  }

  const formClass = isEdit
    ? "flex flex-col gap-3 text-sm"
    : "flex flex-col gap-4 rounded-2xl border border-border bg-card p-6 text-sm shadow-sm";

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className={formClass}>
        {!isEdit ? (
          <h2 className="text-base font-medium text-foreground">Add LLM provider</h2>
        ) : null}

        <div className="flex gap-3">
          <FormField
            control={form.control}
            name="kind"
            render={({ field }) => (
              <FormItem className="w-40">
                <FormLabel>Kind</FormLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {LLM_KINDS.map((k) => (
                      <SelectItem key={k} value={k}>
                        {LLM_KIND_LABELS[k]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="role"
            render={({ field }) => (
              <FormItem className="w-40">
                <FormLabel>Role</FormLabel>
                <Select
                  value={field.value}
                  disabled={isEdit}
                  onValueChange={(next) => {
                    const nextRole = next as Role;
                    field.onChange(nextRole);
                    if (props.mode === "create") {
                      form.setValue("isDefault", props.defaultRoleAvailability[nextRole]);
                    }
                  }}
                >
                  <FormControl>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value="chat">Chat</SelectItem>
                    <SelectItem value="guardrail">Guardrail</SelectItem>
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="label"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>Label</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    placeholder={role === "guardrail" ? "OpenAI guardrail" : "OpenAI prod"}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {!isEdit ? (
          <p className="-mt-2 text-xs text-muted-foreground">
            {role === "chat"
              ? "Chat rows feed the agent loop. The conversation LLM picker only sees chat rows."
              : "Guardrail rows feed the prompt-injection / topic-scope / output-safety classifier. They run alongside chat — never as the chat model. A small / cheap model is recommended (e.g. gpt-5-nano)."}
          </p>
        ) : null}

        <FormField
          control={form.control}
          name="apiKey"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{isEdit ? "API key (leave blank to keep current)" : "API key"}</FormLabel>
              <FormControl>
                <Input
                  {...field}
                  type="password"
                  autoComplete="off"
                  placeholder="sk-..."
                  className="font-mono"
                />
              </FormControl>
              <FormDescription className="text-xs">
                {isEdit ? (
                  "Stored encrypted at rest. Only fill this in to rotate the key."
                ) : (
                  <>
                    Stored encrypted at rest. Format depends on the vendor (OpenAI starts with{" "}
                    <code className="rounded bg-muted px-1 py-0.5 font-mono">sk-</code>, Anthropic
                    with <code className="rounded bg-muted px-1 py-0.5 font-mono">sk-ant-</code>).
                  </>
                )}
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex gap-3">
          <FormField
            control={form.control}
            name="model"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>{isEdit ? "Model" : "Model (optional)"}</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="gpt-5" />
                </FormControl>
                <FormDescription className="text-xs">
                  {isEdit ? (
                    "Optional override. Empty lets the adapter pick its default."
                  ) : (
                    <>
                      Optional override (e.g.{" "}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono">gpt-5</code>,{" "}
                      <code className="rounded bg-muted px-1 py-0.5 font-mono">
                        claude-sonnet-4-6
                      </code>
                      ). Empty lets the adapter pick its default.
                    </>
                  )}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="baseUrl"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>{isEdit ? "Base URL" : "Base URL (optional)"}</FormLabel>
                <FormControl>
                  <Input {...field} placeholder="https://api.openai.com/v1" />
                </FormControl>
                <FormDescription className="text-xs">
                  Only set for non-vanilla endpoints — Azure OpenAI, an internal proxy, or a
                  self-hosted Ollama. Blank uses the vendor's public endpoint.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex gap-3">
          <FormField
            control={form.control}
            name="inputPrice"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>Input price ($ / Mtok)</FormLabel>
                <FormControl>
                  <Input {...field} type="text" inputMode="decimal" placeholder="2.00" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="outputPrice"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>Output price ($ / Mtok)</FormLabel>
                <FormControl>
                  <Input {...field} type="text" inputMode="decimal" placeholder="8.00" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
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
          <FormField
            control={form.control}
            name="isDefault"
            render={({ field }) => (
              <FormItem className="flex flex-col gap-1">
                <div className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  <FormControl>
                    <Switch checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <Label>Make this the {role === "guardrail" ? "guardrail" : "chat"} default</Label>
                </div>
                <FormDescription className="text-xs">
                  {role === "guardrail"
                    ? "Becomes the fallback used by any project that hasn't pinned its own guardrail row. The pattern guardrail still runs first regardless."
                    : "Becomes the fallback used by any project that hasn't picked its own chat LLM. Per-conversation overrides still win."}
                </FormDescription>
              </FormItem>
            )}
          />
        ) : null}

        {mutation.error ? (
          <Alert variant="destructive">
            <AlertDescription>{mutation.error.message}</AlertDescription>
          </Alert>
        ) : null}

        {isEdit ? (
          <div className="flex items-center gap-2">
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={props.onClose}
              disabled={mutation.isPending}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="submit" disabled={mutation.isPending} className="self-start">
            {mutation.isPending ? "Creating…" : "Create"}
          </Button>
        )}
      </form>
    </Form>
  );
}
