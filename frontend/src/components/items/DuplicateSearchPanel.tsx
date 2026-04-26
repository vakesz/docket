import type { DTO } from "~/api/client";
import { Notice } from "~/components/common/Notice";
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
    <Notice tone="warning" title={`Possible duplicates (${duplicates.length})`}>
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
    </Notice>
  );
}
