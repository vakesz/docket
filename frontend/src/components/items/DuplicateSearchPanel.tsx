import type { DTO } from "~/api/client";
import { formatState } from "~/lib/format";

export function DuplicateSearchPanel({
  loading,
  duplicates,
}: {
  loading: boolean;
  duplicates: DTO["ItemDTO"][];
}) {
  if (loading && duplicates.length === 0) {
    return <p className="text-xs text-fg-muted">Checking for duplicates…</p>;
  }
  if (duplicates.length === 0) return null;
  return (
    <div className="rounded-xl border border-warning bg-warning-bg/40 px-3 py-2 text-xs text-warning-fg">
      <div className="mb-1 font-semibold">Possible duplicates ({duplicates.length})</div>
      <ul className="flex flex-col gap-0.5 font-mono text-[11px]">
        {duplicates.map((it) => (
          <li key={it.id} className="truncate">
            <a
              href={`/items/${encodeURIComponent(it.id)}`}
              target="_blank"
              rel="noreferrer"
              className="hover:underline"
            >
              [{it.id}] {it.title}
            </a>
            <span className="ml-2 text-fg-muted">— {formatState(it.state)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
