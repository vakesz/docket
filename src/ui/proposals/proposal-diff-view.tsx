import type { ProposalDiff } from "@/server/proposals/diff";
import { Badge } from "@/ui/primitives/badge";

export function ProposalDiffView({ diff }: { diff: ProposalDiff }) {
  switch (diff.kind) {
    case "state_change":
      return (
        <div className="flex flex-col gap-3 text-sm">
          <Field label="Item">
            <span className="font-medium">{diff.itemTitle}</span>{" "}
            <span className="text-muted-foreground">({diff.itemId})</span>
          </Field>
          <Field label="Transition">
            <Pill>{diff.before}</Pill>
            <span className="text-muted-foreground">→</span>
            <Pill tone="primary">{diff.intent}</Pill>
          </Field>
        </div>
      );

    case "description_patch":
      return (
        <div className="flex flex-col gap-3 text-sm">
          <Field label="Item">
            <span className="font-medium">{diff.itemTitle}</span>{" "}
            <span className="text-muted-foreground">({diff.itemId})</span>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <DiffBlock label="Before" tone="muted" body={diff.before} />
            <DiffBlock label="After" tone="primary" body={diff.after} />
          </div>
        </div>
      );

    case "comment_add":
      return (
        <div className="flex flex-col gap-3 text-sm">
          <Field label="Item">
            <span className="font-medium">{diff.itemTitle}</span>{" "}
            <span className="text-muted-foreground">({diff.itemId})</span>
          </Field>
          <DiffBlock label="New comment" tone="primary" body={diff.bodyMd} />
        </div>
      );

    case "tags_change":
      return (
        <div className="flex flex-col gap-3 text-sm">
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
              <span className="italic text-muted-foreground">(no tags)</span>
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
        <div className="flex flex-col gap-3 text-sm">
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
          {diff.descriptionMd ? (
            <DiffBlock label="Description" tone="primary" body={diff.descriptionMd} />
          ) : null}
        </div>
      );

    case "attachment_upload":
      return (
        <div className="flex flex-col gap-3 text-sm">
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
        <div className="flex flex-col gap-3 text-sm">
          <Field label={diff.memoryId ? "Update memory" : "Create memory"}>
            <span className="font-medium">{diff.title}</span>
          </Field>
          {diff.memoryId ? (
            <div className="grid grid-cols-2 gap-3">
              <DiffBlock label="Before" tone="muted" body={diff.previousBodyMd} />
              <DiffBlock label="After" tone="primary" body={diff.bodyMd} />
            </div>
          ) : (
            <DiffBlock label="Body" tone="primary" body={diff.bodyMd} />
          )}
        </div>
      );

    case "memory_delete":
      return (
        <div className="flex flex-col gap-3 text-sm">
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
      <span className="w-24 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
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
}: {
  label: string;
  body: string;
  tone: "muted" | "primary";
}) {
  const border = tone === "primary" ? "border-primary/30" : "border-border";
  return (
    <div className={`flex min-w-0 flex-col gap-1 rounded-md border ${border} p-2`}>
      <span className="text-xs uppercase tracking-wide text-muted-foreground">{label}</span>
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
        {body || "(empty)"}
      </pre>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
