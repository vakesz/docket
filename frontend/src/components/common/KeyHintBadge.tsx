/**
 * Renders a non-secret preview of the stored LLM API key so a user can
 * verify which key is loaded before rotating or removing it. The hint
 * (`prefix … suffix · N chars · updated Xd ago`) comes from
 * `config.llm.key_hint` on `GET /api/settings`. Returns `null` when no
 * key is configured — callers handle the empty state themselves.
 *
 * `SettingsDTO.config` is typed as `dict[str, Any]` on the backend, so the
 * OpenAPI schema doesn't surface `KeyHintConfig` as a top-level DTO. We
 * declare the shape inline; if the backend renames a field, the form
 * helper that builds this object catches it.
 */
import { KeyRound } from "lucide-react";

export interface KeyHint {
  configured: boolean;
  prefix: string;
  suffix: string;
  length: number;
  updated_at: string | null;
}

export function KeyHintBadge({ hint }: { hint: KeyHint | null | undefined }) {
  if (!hint?.configured) return null;
  const preview = hint.prefix && hint.suffix ? `${hint.prefix}…${hint.suffix}` : "•••";
  const length = hint.length ? `${hint.length} chars` : null;
  const ago = formatRelative(hint.updated_at);
  const meta = [length, ago].filter(Boolean).join(" · ");
  return (
    <span className="inline-flex items-center gap-2 rounded-md border border-border bg-bg-muted px-2 py-1 font-mono text-[11px] text-fg-muted">
      <KeyRound className="h-3 w-3 shrink-0" />
      <span className="text-fg">{preview}</span>
      {meta && <span className="text-fg-muted">· {meta}</span>}
    </span>
  );
}

function formatRelative(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return "updated just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `updated ${days}d ago`;
}
