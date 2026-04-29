"use client";

import Image from "next/image";
import { useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Badge } from "@/ui/primitives/badge";
import { Button } from "@/ui/primitives/button";
import { MCP_TEMPLATES, type McpTemplate } from "./templates";

const FEATURED_IDS = new Set(["github", "notion", "atlassian", "linear"]);

/**
 * Template chip grid above the free-form add form. Clicking "Add" stages
 * a disabled row with the template's URL — the user then opens the row's
 * editor to fill in credentials and enable it.
 *
 * Featured templates surface up top; the rest collapse under a "Show more"
 * toggle so the panel doesn't sprawl.
 */
export function McpTemplatePicker({
  projectId,
  existingNames,
}: {
  projectId: string;
  existingNames: Set<string>;
}) {
  const utils = trpc.useUtils();
  const create = trpc.mcp.create.useMutation({
    onSuccess: () => utils.mcp.list.invalidate({ projectId }),
  });
  const [error, setError] = useState<string | null>(null);
  const [showMore, setShowMore] = useState(false);

  const featured = MCP_TEMPLATES.filter((t) => FEATURED_IDS.has(t.id));
  const more = MCP_TEMPLATES.filter((t) => !FEATURED_IDS.has(t.id));

  const onAdd = async (template: McpTemplate) => {
    setError(null);
    try {
      const name = uniqueName(template.defaultName, existingNames);
      await create.mutateAsync({
        projectId,
        name,
        url: template.url,
        headersJson: {},
        enabled: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const renderChip = (t: McpTemplate) => (
    <li
      key={t.id}
      className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-3 shadow-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <TemplateIcon template={t} />
          <span className="truncate text-sm font-medium text-foreground">{t.label}</span>
        </span>
        <Badge variant="secondary" className="uppercase tracking-wide">
          {authBadge(t)}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{t.description}</p>
      <div className="flex items-center justify-between gap-2">
        <a
          href={t.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] text-muted-foreground underline"
        >
          Docs
        </a>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => void onAdd(t)}
          disabled={create.isPending}
        >
          {create.isPending ? "Adding…" : "Add"}
        </Button>
      </div>
    </li>
  );

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Add from template</h3>
        <span className="text-xs text-muted-foreground">
          Off by default — fill in credentials to enable.
        </span>
      </div>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {featured.map(renderChip)}
      </ul>
      {showMore && (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {more.map(renderChip)}
        </ul>
      )}
      <button
        type="button"
        className="self-start text-xs text-muted-foreground underline"
        onClick={() => setShowMore((prev) => !prev)}
      >
        {showMore ? "Show fewer" : `Show ${more.length} more`}
      </button>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function TemplateIcon({ template }: { template: McpTemplate }) {
  if (template.iconDark) {
    return (
      <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center">
        <Image
          src={template.icon}
          alt=""
          width={28}
          height={28}
          className="h-7 w-7 dark:hidden"
          aria-hidden="true"
          unoptimized
        />
        <Image
          src={template.iconDark}
          alt=""
          width={28}
          height={28}
          className="hidden h-7 w-7 dark:block"
          aria-hidden="true"
          unoptimized
        />
      </span>
    );
  }
  return (
    <Image
      src={template.icon}
      alt=""
      width={28}
      height={28}
      className="h-7 w-7 shrink-0"
      aria-hidden="true"
      unoptimized
    />
  );
}

function authBadge(t: McpTemplate): string {
  if (t.authMode === "none") return "No auth";
  if (t.authMode === "oauth-or-header") return "OAuth / token";
  return "Token";
}

function uniqueName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}
