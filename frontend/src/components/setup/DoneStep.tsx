/**
 * Post-/setup/complete done screen.
 *
 * The backend SIGTERMs itself shortly after the response so the operator can
 * re-run `docket serve` with the freshly-written config. We don't auto-reload
 * — the operator's terminal is the source of truth, and a stale connection
 * after the SIGTERM looks like a hang.
 */
import type { DTO } from "~/api/client";
import { Notice } from "~/components/common/Notice";

interface Props {
  result: DTO["SetupCompleteDTO"];
}

export function DoneStep({ result }: Props) {
  return (
    <Notice tone="ok" title="Configuration written">
      <div className="flex flex-col gap-3">
        <div className="font-mono text-[11px]">{result.config_path}</div>
        {result.initial_sync && (
          <div className="font-mono text-[11px]">
            Initial sync: upserted {result.initial_sync.upserted}, archived{" "}
            {result.initial_sync.archived}
          </div>
        )}
        <div>
          The backend has shut itself down so you can pick up the new config. Re-run{" "}
          <code className="rounded bg-success-bg/40 px-1">make serve</code> (or{" "}
          <code className="rounded bg-success-bg/40 px-1">uv run docket serve</code>) in your
          terminal, then refresh this page.
        </div>
        <div className="text-xs text-fg-muted">
          You can also continue from the terminal — open the TUI with{" "}
          <code className="rounded bg-success-bg/40 px-1">uv run docket</code>.
        </div>
      </div>
    </Notice>
  );
}
