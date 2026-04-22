import { useStatus } from "~/api/hooks";
import { cn } from "~/lib/cn";
import { formatRelative } from "~/lib/format";

export function StatusFooter() {
  const status = useStatus(30_000);
  const s = status.data;

  return (
    <footer className="flex h-6 items-center gap-3 border-t border-zinc-200 bg-zinc-50 px-3 font-mono text-[11px] text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      {s ? (
        <>
          <Dot ok={!s.offline} label={s.offline ? "Offline" : "Online"} />
          <span>
            <Key>prov</Key> {s.provider_display || s.provider_key || "—"}
          </span>
          <span>
            <Key>scope</Key> {s.scope_key || "—"}
          </span>
          <span>
            <Key>sync</Key> {formatRelative(s.last_sync_at)}
          </span>
          {s.pending_proposals > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              <Key>pending</Key> {s.pending_proposals}
            </span>
          )}
          {s.read_only && <span className="text-amber-600 dark:text-amber-400">read-only</span>}
          <span className="ml-auto">
            <Key>chat</Key> {s.chat_enabled ? "on" : "off"}
          </span>
        </>
      ) : (
        <span>{status.isPending ? "Connecting…" : (status.error?.message ?? "—")}</span>
      )}
    </footer>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <span className="text-zinc-400 dark:text-zinc-600">{children}</span>;
}

function Dot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 rounded-full", ok ? "bg-emerald-500" : "bg-rose-500")}
      />
      <span>{label}</span>
    </span>
  );
}
