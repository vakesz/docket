import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/cn";
import { ProviderSwitcher } from "./ProviderSwitcher";

export function TopBar() {
  return (
    <header className="flex h-11 items-center gap-3 border-b border-border bg-bg px-3">
      <Link
        to="/items"
        className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-fg"
      >
        Docket
      </Link>
      <div className="ml-auto flex items-center gap-2">
        <ProviderSwitcher />
        <NavLink to="/settings">Settings</NavLink>
      </div>
    </header>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className={cn("rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-alt hover:text-fg")}
      activeProps={{
        className: "bg-surface-alt text-fg",
      }}
    >
      {children}
    </Link>
  );
}
