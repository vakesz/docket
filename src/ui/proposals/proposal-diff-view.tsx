import { formatIntent, formatState } from "@/lib/format";
import type { ProposalDiff } from "@/server/proposals/diff";
import { MarkdownLazy } from "@/ui/markdown/markdown-lazy";
import { Badge } from "@/ui/primitives/badge";

export function ProposalDiffView({ diff }: { diff: ProposalDiff }) {
  switch (diff.kind) {
    case "state_change":
      return (
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <Field label="Item">
            <span className="font-medium">{diff.itemTitle}</span>{" "}
            <span className="text-muted-foreground">({diff.itemId})</span>
          </Field>
          <Field label="Transition">
            <Pill>{formatState(diff.before)}</Pill>
            <span className="text-muted-foreground">→</span>
            <Pill tone="primary">{formatIntent(diff.intent)}</Pill>
          </Field>
        </div>
      );

    case "description_patch":
      return (
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <Field label="Item">
            <span className="font-medium">{diff.itemTitle}</span>{" "}
            <span className="text-muted-foreground">({diff.itemId})</span>
          </Field>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <DiffBlock label="Before" tone="muted" body={diff.before} markdown />
            <DiffBlock label="After" tone="primary" body={diff.after} markdown />
          </div>
        </div>
      );

    case "comment_add":
      return (
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <Field label="Item">
            <span className="font-medium">{diff.itemTitle}</span>{" "}
            <span className="text-muted-foreground">({diff.itemId})</span>
          </Field>
          <DiffBlock label="New comment" tone="primary" body={diff.body} markdown />
        </div>
      );

    case "tags_change":
      return (
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <Field label="Item">
            <span className="font-medium">{diff.itemTitle}</span>{" "}
            <span className="text-muted-foreground">({diff.itemId})</span>
          </Field>
          {diff.added.length > 0 ? (
            <Field label="Adding">
              <span className="flex flex-wrap gap-1">
                {diff.added.map((t) => (
                  <Pill key={t} tone="primary">
                    +{t}
                  </Pill>
                ))}
              </span>
            </Field>
          ) : null}
          {diff.removed.length > 0 ? (
            <Field label="Removing">
              <span className="flex flex-wrap gap-1">
                {diff.removed.map((t) => (
                  <Pill key={t}>−{t}</Pill>
                ))}
              </span>
            </Field>
          ) : null}
          <Field label="Result">
            {diff.after.length === 0 ? (
              <span className="text-muted-foreground italic">(no tags)</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {diff.after.map((t) => (
                  <Pill key={t}>{t}</Pill>
                ))}
              </span>
            )}
          </Field>
        </div>
      );

    case "item_create":
      return (
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <Field label="Kind">
            <Pill>{diff.itemKind}</Pill>
          </Field>
          <Field label="Title">
            <span className="font-medium">{diff.title}</span>
          </Field>
          {diff.assignee ? <Field label="Assignee">{diff.assignee}</Field> : null}
          {diff.tags.length > 0 ? (
            <Field label="Tags">
              <span className="flex flex-wrap gap-1">
                {diff.tags.map((t) => (
                  <Pill key={t}>{t}</Pill>
                ))}
              </span>
            </Field>
          ) : null}
          {diff.description ? (
            <DiffBlock label="Description" tone="primary" body={diff.description} markdown />
          ) : null}
        </div>
      );

    case "attachment_upload":
      return (
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <Field label="Item">
            <span className="font-medium">{diff.itemTitle}</span>{" "}
            <span className="text-muted-foreground">({diff.itemId})</span>
          </Field>
          <Field label="File">
            <span className="font-medium">{diff.filename}</span>{" "}
            <span className="text-muted-foreground">
              ({diff.contentType}, {formatBytes(diff.size)})
            </span>
          </Field>
        </div>
      );

    case "memory_write":
      return (
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <Field label={diff.memoryId ? "Update memory" : "Create memory"}>
            <span className="font-medium">{diff.title}</span>
          </Field>
          {diff.memoryId ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <DiffBlock label="Before" tone="muted" body={diff.previousBody} markdown />
              <DiffBlock label="After" tone="primary" body={diff.body} markdown />
            </div>
          ) : (
            <DiffBlock label="Body" tone="primary" body={diff.body} markdown />
          )}
        </div>
      );

    case "memory_delete":
      return (
        <div className="flex min-w-0 flex-col gap-3 text-sm">
          <Field label="Delete memory">
            <span className="font-medium">{diff.title}</span>{" "}
            <span className="text-muted-foreground">({diff.memoryId})</span>
          </Field>
        </div>
      );
  }
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-24 shrink-0 text-muted-foreground text-xs uppercase tracking-wide">
        {label}
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 break-words">
        {children}
      </span>
    </div>
  );
}

function Pill({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "primary";
}) {
  return (
    <Badge
      variant={tone === "primary" ? "default" : "secondary"}
      className={
        tone === "primary"
          ? "bg-primary/10 text-primary uppercase tracking-wide"
          : "uppercase tracking-wide"
      }
    >
      {children}
    </Badge>
  );
}

function DiffBlock({
  label,
  body,
  tone,
  markdown = false,
}: {
  label: string;
  body: string;
  tone: "muted" | "primary";
  markdown?: boolean;
}) {
  const border = tone === "primary" ? "border-primary/30" : "border-border";
  const isEmpty = body.trim().length === 0;
  return (
    <div className={`flex min-w-0 flex-col gap-1 rounded-md border ${border} p-2`}>
      <span className="text-muted-foreground text-xs uppercase tracking-wide">{label}</span>
      {isEmpty ? (
        <span className="text-muted-foreground/70 text-xs italic">(empty)</span>
      ) : markdown ? (
        <MarkdownLazy source={body} className="text-xs" />
      ) : (
        <pre className="whitespace-pre-wrap break-words text-xs">{body}</pre>
      )}
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
