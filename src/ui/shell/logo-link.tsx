"use client";
import type { Route } from "next";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { DocketLogo } from "@/ui/setup/docket-logo";

/**
 * On `/settings` the active project is carried in `?project=<slug>` (the
 * ProjectSwitcher rewrites that query on switch), so the logo has to read
 * the URL client-side to stay aligned with the switcher. Anywhere else,
 * the server-resolved `currentProjectSlug` is authoritative.
 */
export function LogoLink({ currentProjectSlug }: { currentProjectSlug: string | null }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onSettings = pathname?.startsWith("/settings") ?? false;
  const urlProject = onSettings ? searchParams.get("project") : null;
  const effective = urlProject ?? currentProjectSlug;
  const href: Route = effective ? (`/projects/${effective}/items` as Route) : "/";

  return (
    <Link
      href={href}
      className="flex shrink-0 items-center gap-2 text-foreground hover:text-primary"
      aria-label="Docket"
    >
      <DocketLogo size={20} className="shrink-0" />
      <span className="font-semibold text-[13px] uppercase tracking-[0.18em]">DOCKET</span>
      <span className="ml-1 hidden font-light text-[12px] text-muted-foreground italic tracking-wide sm:inline">
        build something cool together
      </span>
    </Link>
  );
}
