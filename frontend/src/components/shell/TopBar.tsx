import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/cn";
import { ProviderSwitcher } from "./ProviderSwitcher";

export function TopBar() {
  return (
    <header className="flex h-12 items-center gap-3 border-b border-border bg-surface/80 px-4 backdrop-blur lg:px-6">
      <Link
        to="/items"
        className="flex items-center gap-2 font-mono text-xs font-semibold uppercase tracking-[0.2em] text-fg"
      >
        <span className="h-2 w-2 rounded-full bg-accent" />
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
