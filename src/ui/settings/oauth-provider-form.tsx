"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";

type OauthDefaults = {
  defaultLabel: string;
  defaultScopes: string;
  baseUrlPlaceholder: string;
};

const FALLBACK_DEFAULTS: OauthDefaults = {
  defaultLabel: "",
  defaultScopes: "",
  baseUrlPlaceholder: "Optional override",
};

export type OauthProviderFormInitial = {
  id: string;
  kind: string;
  label: string;
  clientId: string;
  scopes: string;
  baseUrl: string;
};

type Props =
  | { mode?: "create"; initial?: undefined; onDone?: () => void }
  | { mode: "edit"; initial: OauthProviderFormInitial; onDone?: () => void };

const formSchema = z.object({
  kind: z.string(),
  label: z.string().trim().min(1, "Label is required"),
  clientId: z.string().trim().min(1, "Client ID is required"),
  clientSecret: z.string(),
  scopes: z.string().trim(),
  baseUrl: z.string().trim(),
});

type FormValues = z.infer<typeof formSchema>;

export function OauthProviderForm(props: Props) {
  const mode = props.mode ?? "create";
  const initial = props.initial;
  const utils = trpc.useUtils();

  // Load OAuth-capable provider kinds from the registry. Until the query
  // resolves we fall back to the spec the row was created with (edit mode)
  // or render an empty picker (create mode); both states clear once the
  // network round-trip lands and the kinds list arrives. The fetch is
  // shared with everything else that reads `projects.kinds`, so it's
  // typically already cached when this form mounts.
  const kinds = trpc.projects.kinds.useQuery(undefined, { staleTime: 5 * 60_000 });
  const oauthKinds = (kinds.data ?? []).filter((k) => k.oauth !== null);
  const defaultsByKind = new Map<string, OauthDefaults>(
    oauthKinds.flatMap((k) => (k.oauth ? [[k.typeId, k.oauth]] : [])),
  );
  const firstKind = oauthKinds[0]?.typeId ?? "";
  const initialDefaults = defaultsByKind.get(initial?.kind ?? firstKind) ?? FALLBACK_DEFAULTS;

  const create = trpc.oauthProviders.create.useMutation({
    onSuccess: async () => {
      const d = defaultsByKind.get(form.getValues("kind")) ?? FALLBACK_DEFAULTS;
      form.reset({
        kind: form.getValues("kind"),
        label: d.defaultLabel,
        clientId: "",
        clientSecret: "",
        scopes: d.defaultScopes,
        baseUrl: "",
      });
      await utils.oauthProviders.list.invalidate();
      props.onDone?.();
    },
  });
  const update = trpc.oauthProviders.update.useMutation({
    onSuccess: async () => {
      await utils.oauthProviders.list.invalidate();
      props.onDone?.();
    },
  });

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      kind: initial?.kind ?? firstKind,
      label: initial?.label ?? initialDefaults.defaultLabel,
      clientId: initial?.clientId ?? "",
      clientSecret: "",
      scopes: initial?.scopes ?? initialDefaults.defaultScopes,
      baseUrl: initial?.baseUrl ?? "",
    },
  });

  const watchKind = form.watch("kind");

  function onKindChange(next: string) {
    form.setValue("kind", next);
    const d = defaultsByKind.get(next) ?? FALLBACK_DEFAULTS;
    form.setValue("label", d.defaultLabel);
    form.setValue("scopes", d.defaultScopes);
  }

  function onSubmit(values: FormValues) {
    if (mode === "create" && values.clientSecret.trim() === "") {
      form.setError("clientSecret", { message: "Client secret is required" });
      return;
    }
    if (mode === "edit" && initial) {
      update.mutate({
        id: initial.id,
        label: values.label.trim(),
        clientId: values.clientId.trim(),
        // Preserve existing ciphertext when the field is left blank.
        clientSecret: values.clientSecret.trim() ? values.clientSecret : undefined,
        scopes: values.scopes.trim(),
        baseUrl: values.baseUrl.trim(),
      });
      return;
    }
    create.mutate({
      kind: values.kind,
      label: values.label.trim(),
      clientId: values.clientId.trim(),
      clientSecret: values.clientSecret.trim(),
      scopes: values.scopes.trim(),
      baseUrl: values.baseUrl.trim(),
    });
  }

  const pending = mode === "edit" ? update.isPending : create.isPending;
  const error = (mode === "edit" ? update.error : create.error)?.message;
  const baseUrlHint = (defaultsByKind.get(watchKind) ?? FALLBACK_DEFAULTS).baseUrlPlaceholder;

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-6 text-sm shadow-sm"
      >
        <h2 className="text-base font-medium text-foreground">
          {mode === "edit" ? "Edit OAuth provider" : "Add OAuth provider"}
        </h2>

        <div className="flex gap-3">
          <FormField
            control={form.control}
            name="kind"
            render={({ field }) => (
              <FormItem className="w-40">
                <FormLabel>Kind</FormLabel>
                {mode === "edit" ? (
                  <FormControl>
                    <Input
                      value={field.value.replace("_", " ")}
                      readOnly
                      className="cursor-not-allowed opacity-70"
                    />
                  </FormControl>
                ) : (
                  <Select value={field.value} onValueChange={onKindChange}>
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {oauthKinds.map((k) => (
                        <SelectItem key={k.typeId} value={k.typeId}>
                          {k.displayName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
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
                  <Input {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="flex gap-3">
          <FormField
            control={form.control}
            name="clientId"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>Client ID</FormLabel>
                <FormControl>
                  <Input {...field} className="font-mono" />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="clientSecret"
            render={({ field }) => (
              <FormItem className="flex-1">
                <FormLabel>
                  Client secret
                  {mode === "edit" ? (
                    <span className="ml-1 font-normal text-muted-foreground/70">
                      (leave blank to keep current)
                    </span>
                  ) : null}
                </FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    type="password"
                    autoComplete="off"
                    placeholder={mode === "edit" ? "•••••••• (unchanged)" : undefined}
                    className="font-mono"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="scopes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Scopes (space-separated)</FormLabel>
              <FormControl>
                <Input {...field} className="font-mono" />
              </FormControl>
              <FormDescription className="text-xs">
                Pre-filled per kind. Only edit if you need extra capability beyond the defaults.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="baseUrl"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Base URL / tenant (optional)</FormLabel>
              <FormControl>
                <Input {...field} placeholder={baseUrlHint} />
              </FormControl>
              <FormDescription className="text-xs">
                GitHub Enterprise base URL (e.g.{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">
                  https://github.example.com
                </code>
                ), or the Entra tenant id for Azure DevOps. Blank ={" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono">github.com</code> /
                multi-tenant <code className="rounded bg-muted px-1 py-0.5 font-mono">common</code>.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex gap-2">
          <Button type="submit" disabled={pending}>
            {pending
              ? mode === "edit"
                ? "Saving…"
                : "Creating…"
              : mode === "edit"
                ? "Save"
                : "Create"}
          </Button>
          {mode === "edit" ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onDone?.()}
              disabled={pending}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      </form>
    </Form>
  );
}
