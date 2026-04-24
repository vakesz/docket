import { useEffect, useState } from "react";
import { useStatus } from "~/api/hooks";
import { cn } from "~/lib/cn";
import { formatRelative } from "~/lib/format";
import { SyncButton } from "./SyncButton";

export function StatusFooter() {
  const status = useStatus(30_000);
  const s = status.data;
  // Tick every 15s so `formatRelative(last_sync_at)` advances between polls
  // instead of freezing at whatever we rendered when `useStatus` last fired.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  return (
    <footer className="flex h-7 items-center gap-3 border-t border-border bg-surface px-3 font-mono text-[11px] text-fg-muted">
      {s ? (
        <>
          <Dot ok={!s.offline} label={s.offline ? "Offline" : "Online"} />
          <span>
            <Key>prov</Key> {s.provider_display || s.provider_key || "—"}
          </span>
          <span>
            <Key>sync</Key> {formatRelative(s.last_sync_at)}
          </span>
          {s.pending_proposals > 0 && (
            <span className="text-warning">
              <Key>pending</Key> {s.pending_proposals}
            </span>
          )}
          {s.read_only && <span className="text-warning">read-only</span>}
          <div className="ml-auto">
            <SyncButton />
          </div>
        </>
      ) : (
        <span>{status.isPending ? "Connecting…" : (status.error?.message ?? "—")}</span>
      )}
    </footer>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return <span className="text-fg-faint">{children}</span>;
}

function Dot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn("h-1.5 w-1.5 rounded-full", ok ? "bg-success" : "bg-danger")}
      />
      <span>{label}</span>
    </span>
  );
}
