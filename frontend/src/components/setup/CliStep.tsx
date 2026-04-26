/**
 * CLI session probe step — equivalent to the wizard's "Checking … session"
 * line plus the retry-after-`gh auth login` confirm.
 *
 * Behaviour:
 *  - Polls `/setup/cli-status` for `gh` and `az` sessions.
 *  - Renders one card per CLI tool with present / logged-in indicators.
 *  - When a tool is missing or unauthenticated, shows the exact command the
 *    operator should run, plus a Retry button that re-fetches the probe.
 *  - The user can always proceed — the next step's provider type filter
 *    surfaces only the providers whose `requires_cli` are satisfied, but
 *    we don't gate forward navigation (mirrors CLI: third-party providers
 *    that need neither tool stay reachable).
 */
import { useCliStatus } from "~/api/hooks";
import { Notice } from "~/components/common/Notice";
import { cn } from "~/lib/cn";
import {
  metaLabelClass,
  primaryButtonClass,
  setupCardClass,
  xsBorderButtonClass,
} from "~/lib/formClasses";

const INSTALL_HINT: Record<string, string> = {
  gh: "macOS: `brew install gh`  ·  Windows: `winget install GitHub.cli`  ·  Linux: see cli.github.com",
  az: "macOS: `brew install azure-cli`  ·  Windows: `winget install Microsoft.AzureCLI`  ·  Linux: see learn.microsoft.com/cli/azure/install",
};

const LOGIN_CMD: Record<string, string> = {
  gh: "gh auth login",
  az: "az login",
};

export function CliStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const cli = useCliStatus();
  const data = cli.data;

  return (
    <div className={setupCardClass}>
      <p>
        Docket reuses your local <code className="rounded bg-surface-alt px-1 text-fg">gh</code> and{" "}
        <code className="rounded bg-surface-alt px-1 text-fg">az</code> sessions for both auth and
        discovery (org/project/repo pickers). If neither tool is signed in, you can still configure
        the demo stub provider — the next step surfaces what's available.
      </p>

      {cli.isPending && <p className="text-xs text-fg-muted">Probing local CLI sessions…</p>}
      {cli.error && (
        <Notice tone="error" title="Could not probe CLI sessions">
          {cli.error.message}
        </Notice>
      )}

      {data && (
        <div className="grid gap-2 sm:grid-cols-2">
          <CliCard
            tool="gh"
            label="GitHub CLI"
            present={data.gh.present}
            loggedIn={data.gh.logged_in}
            identity={data.gh.identity}
            error={data.gh.error}
          />
          <CliCard
            tool="az"
            label="Azure CLI"
            present={data.az.present}
            loggedIn={data.az.logged_in}
            identity={data.az.identity}
            error={data.az.error}
          />
        </div>
      )}

      {data && data.gh_hosts && data.gh_hosts.length > 0 && (
        <section className="flex flex-col gap-1">
          <span className={metaLabelClass}>Authenticated GitHub hosts</span>
          <ul className="font-mono text-[11px] text-fg-muted">
            {data.gh_hosts.map((h) => (
              <li key={h.hostname}>
                {h.hostname} → {h.api_base_url}
              </li>
            ))}
          </ul>
        </section>
      )}

      {data && !data.keyring_available && (
        <Notice tone="warning" title="OS keyring unavailable">
          {data.keyring_error || "no backend detected"}. The wizard can still write{" "}
          <code className="rounded bg-warning-bg/40 px-1">config.toml</code>, but you'll need to
          install a keyring backend (Keychain / Credential Manager / gnome-keyring / kwallet) before
          chat works.
        </Notice>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button type="button" onClick={onBack} className="text-xs text-fg-muted hover:text-fg">
            ← Back
          </button>
          <button
            type="button"
            disabled={cli.isFetching}
            onClick={() => cli.refetch()}
            className={xsBorderButtonClass}
          >
            {cli.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <button type="button" onClick={onNext} className={primaryButtonClass}>
          Next
        </button>
      </div>

      <span className="text-xs text-fg-muted">
        {LOGIN_CMD.gh && INSTALL_HINT.gh ? (
          <>
            Need to sign in? Run <code className="rounded bg-surface-alt px-1">gh auth login</code>{" "}
            or <code className="rounded bg-surface-alt px-1">az login</code> in another terminal,
            then click Refresh.
          </>
        ) : null}
      </span>
    </div>
  );
}

function CliCard({
  tool,
  label,
  present,
  loggedIn,
  identity,
  error,
}: {
  tool: "gh" | "az";
  label: string;
  present: boolean;
  loggedIn: boolean;
  identity: string;
  error: string;
}) {
  const ok = present && loggedIn;
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-xl border p-3",
        ok ? "border-success bg-success-bg/40" : "border-border",
      )}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">{label}</span>
        <span className={cn("text-xs", ok ? "text-success-fg" : "text-fg-muted")}>
          {ok ? `signed in · ${identity}` : present ? "needs login" : "not installed"}
        </span>
      </div>
      {!present && (
        <span className={cn("font-mono text-[10px] leading-relaxed", metaLabelClass)}>
          {INSTALL_HINT[tool]}
        </span>
      )}
      {present && !loggedIn && (
        <span className="font-mono text-[11px] text-fg-muted">
          run <code className="rounded bg-surface-alt px-1">{LOGIN_CMD[tool]}</code>
          {error ? ` — ${error}` : ""}
        </span>
      )}
    </div>
  );
}
