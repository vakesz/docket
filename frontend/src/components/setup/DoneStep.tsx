/**
 * Post-/setup/complete done screen.
 *
 * The backend bootstrap process restarts itself into live mode after the
 * response flushes. We poll `/api/setup/status` every second and reload the
 * page once it reports `needs_setup=false` — that's the signal that the
 * live FastAPI app is up and the SPA should rehydrate against real routes.
 */
import { useEffect, useState } from "react";

import type { DTO } from "~/api/client";
import { api } from "~/api/client";
import { Notice } from "~/components/common/Notice";

interface Props {
  result: DTO["SetupCompleteDTO"];
}

export function DoneStep({ result }: Props) {
  const [waited, setWaited] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const status = await api.get<DTO["SetupStatusDTO"]>("/setup/status");
        if (!cancelled && !status.needs_setup) {
          window.location.reload();
          return;
        }
      } catch {
        // Brief window where the bootstrap server has shut down but the live
        // one isn't accepting yet — keep polling.
      }
      if (!cancelled) {
        setWaited((s) => s + 1);
        window.setTimeout(tick, 1000);
      }
    };
    const handle = window.setTimeout(tick, 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, []);

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
          Restarting docket into live mode… this page will reload automatically once the API is back
          {waited > 5 ? ` (waiting ${waited}s)` : ""}.
        </div>
        <div className="text-xs text-fg-muted">
          You can also continue from the terminal — open the TUI with{" "}
          <code className="rounded bg-success-bg/40 px-1">uv run docket</code>.
        </div>
      </div>
    </Notice>
  );
}
