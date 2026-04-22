import { Link } from "@tanstack/react-router";

import { cn } from "~/lib/cn";
import { ProviderSwitcher } from "./ProviderSwitcher";
import { ScopeSwitcher } from "./ScopeSwitcher";
import { SyncButton } from "./SyncButton";
import { ThemeToggle } from "./ThemeToggle";

export function TopBar() {
  return (
    <header className="flex h-11 items-center gap-3 border-b border-zinc-200 bg-white px-3 dark:border-zinc-800 dark:bg-zinc-950">
      <Link
        to="/items"
        className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-zinc-900 dark:text-zinc-100"
      >
        Docket
      </Link>
      <nav className="flex items-center gap-1 text-xs">
        <NavLink to="/items">Items</NavLink>
        <NavLink to="/pinned">Pinned</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <ProviderSwitcher />
        <ScopeSwitcher />
        <SyncButton />
        <ThemeToggle />
      </div>
    </header>
  );
}

function NavLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      className={cn(
        "rounded px-2 py-1 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900",
        "dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100",
      )}
      activeProps={{
        className: "bg-zinc-100 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100",
      }}
    >
      {children}
    </Link>
  );
}
