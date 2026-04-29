"use client";

import { useEffect, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { Textarea } from "@/ui/primitives/textarea";
import {
  findTemplateByUrl,
  type McpTemplate,
  templateHeadersComplete,
  unwrapField,
  wrapField,
} from "./templates";

export type EditorRow = {
  id: string;
  name: string;
  url: string;
  headersJson: Record<string, string>;
  enabled: boolean;
  hasOauth: boolean;
};

/**
 * Per-row editor for MCP servers. Two modes — the row's URL maps to a
 * known template (structured per-field inputs) or it doesn't (free-form
 * JSON textarea). A "Switch to advanced" link toggles between them so
 * power users can drop into raw JSON for non-template rows or unusual
 * headers on a template row.
 */
export function McpServerEditor({
  projectId,
  row,
  onClose,
}: {
  projectId: string;
  row: EditorRow;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const update = trpc.mcp.update.useMutation({
    onSuccess: () => {
      utils.mcp.list.invalidate({ projectId });
      onClose();
    },
  });
  const startOauth = trpc.mcp.oauth.start.useMutation();
  const disconnectOauth = trpc.mcp.oauth.disconnect.useMutation({
    onSuccess: () => utils.mcp.list.invalidate({ projectId }),
  });

  const initialTemplate = findTemplateByUrl(row.url);
  const [advanced, setAdvanced] = useState(initialTemplate === undefined);
  const [url, setUrl] = useState(row.url);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() =>
    initFieldValues(initialTemplate, row.headersJson),
  );
  const [rawJson, setRawJson] = useState(() =>
    Object.keys(row.headersJson).length === 0 ? "" : JSON.stringify(row.headersJson, null, 2),
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setUrl(row.url);
    setFieldValues(initFieldValues(initialTemplate, row.headersJson));
    setRawJson(
      Object.keys(row.headersJson).length === 0 ? "" : JSON.stringify(row.headersJson, null, 2),
    );
  }, [row, initialTemplate]);

  const template = findTemplateByUrl(url) ?? initialTemplate;
  const showStructured = !advanced && template !== undefined;

  const onSave = async (enable: boolean) => {
    setError(null);
    let headersJson: Record<string, string>;
    if (showStructured && template) {
      headersJson = { ...row.headersJson };
      for (const field of template.fields) {
        const wrapped = wrapField(field, fieldValues[field.key] ?? "");
        if (wrapped) headersJson[field.key] = wrapped;
        else delete headersJson[field.key];
      }
    } else {
      if (rawJson.trim() === "") {
        headersJson = {};
      } else {
        try {
          const parsed = JSON.parse(rawJson);
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            Object.values(parsed).some((v) => typeof v !== "string")
          ) {
            setError("Headers must be a JSON object of string → string.");
            return;
          }
          headersJson = parsed as Record<string, string>;
        } catch (err) {
          setError(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }
    }
    await update.mutateAsync({
      projectId,
      serverId: row.id,
      url,
      headersJson,
      enabled: enable,
    });
  };

  const onConnectOauth = async () => {
    setError(null);
    try {
      const res = await startOauth.mutateAsync({ projectId, serverId: row.id });
      window.open(res.authorizationUrl, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const onDisconnectOauth = async () => {
    setError(null);
    try {
      await disconnectOauth.mutateAsync({ projectId, serverId: row.id });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const ready =
    !showStructured ||
    !template ||
    templateHeadersComplete(
      template,
      assembleStructuredHeaders(template, row.headersJson, fieldValues),
    );

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border bg-muted/40 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">Configure {row.name}</span>
        <button
          type="button"
          className="text-xs text-muted-foreground underline"
          onClick={() => setAdvanced((prev) => !prev)}
        >
          {advanced ? "Use template fields" : "Advanced (raw JSON)"}
        </button>
      </div>
      <Label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">URL</span>
        <Input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          maxLength={500}
          disabled={row.hasOauth}
        />
      </Label>

      {showStructured && template ? (
        <StructuredFields
          template={template}
          values={fieldValues}
          onChange={(key, value) => setFieldValues((prev) => ({ ...prev, [key]: value }))}
        />
      ) : (
        <Label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Headers JSON</span>
          <Textarea
            value={rawJson}
            onChange={(e) => setRawJson(e.target.value)}
            rows={4}
            placeholder='{"Authorization": "Bearer ..."}'
            className="font-mono text-xs"
          />
        </Label>
      )}

      {template?.supportsOauth && template.authMode === "oauth-or-header" && (
        <Alert>
          <AlertDescription className="flex flex-col gap-2 text-xs">
            {template.oauthHint ?? "This server supports OAuth — connect to mint a bearer token."}
            <div className="flex flex-wrap gap-2">
              {row.hasOauth ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void onDisconnectOauth()}
                  disabled={disconnectOauth.isPending}
                >
                  {disconnectOauth.isPending ? "Disconnecting…" : "Disconnect OAuth"}
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  onClick={() => void onConnectOauth()}
                  disabled={startOauth.isPending}
                >
                  {startOauth.isPending ? "Starting…" : "Connect with OAuth"}
                </Button>
              )}
              <a
                href={template.docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground underline self-center"
              >
                Docs
              </a>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="xs" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => void onSave(false)}
          disabled={update.isPending}
        >
          Save (keep disabled)
        </Button>
        <Button
          type="button"
          size="xs"
          onClick={() => void onSave(true)}
          disabled={update.isPending || !ready}
        >
          {update.isPending ? "Saving…" : row.enabled ? "Save" : "Save & enable"}
        </Button>
      </div>
    </div>
  );
}

function StructuredFields({
  template,
  values,
  onChange,
}: {
  template: McpTemplate;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  if (template.fields.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No credentials required. Save & enable to connect.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {template.fields.map((field) => (
        <Label key={field.key} className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">{field.label}</span>
          <Input
            type="password"
            value={values[field.key] ?? ""}
            onChange={(e) => onChange(field.key, e.target.value)}
            placeholder={field.placeholder}
            autoComplete="off"
          />
          <span className="text-[11px] text-muted-foreground">{field.helpText}</span>
        </Label>
      ))}
    </div>
  );
}

function initFieldValues(
  template: McpTemplate | undefined,
  headers: Record<string, string>,
): Record<string, string> {
  if (!template) return {};
  const out: Record<string, string> = {};
  for (const field of template.fields) {
    out[field.key] = unwrapField(field, headers[field.key]);
  }
  return out;
}

function assembleStructuredHeaders(
  template: McpTemplate,
  base: Record<string, string>,
  values: Record<string, string>,
): Record<string, string> {
  const merged = { ...base };
  for (const field of template.fields) {
    const wrapped = wrapField(field, values[field.key] ?? "");
    if (wrapped) merged[field.key] = wrapped;
    else delete merged[field.key];
  }
  return merged;
}
