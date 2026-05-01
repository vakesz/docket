"use client";
import { ChevronDown, FolderPlus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/ui/primitives/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/ui/primitives/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/primitives/popover";

type ProjectOption = {
  id: string;
  slug: string;
  name: string;
  providerKind: string;
};

const SEARCH_THRESHOLD = 5;

/**
 * Single source of truth for switching projects across the chrome. Lives
 * in the topbar; identical behavior on items and settings.
 *
 * On `/settings` the trigger reflects `?project=<slug>` (the page's active
 * project) rather than the user's pinned default, and switching just
 * rebinds the query so the user keeps the same settings section. Anywhere
 * else, switching navigates to `/projects/<slug>/items`.
 *
 * The popover footer carries the "Add project" deep-link so it stays a
 * real button (not a sentinel item) — keyboard + screen-reader users get
 * correct semantics.
 */
export function ProjectSwitcher({
  projects,
  currentProjectSlug,
}: {
  projects: ProjectOption[];
  currentProjectSlug: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onSettings = pathname?.startsWith("/settings") ?? false;

  const urlProject = onSettings ? searchParams.get("project") : null;
  const effective =
    urlProject && projects.some((p) => p.slug === urlProject) ? urlProject : currentProjectSlug;

  const current = projects.find((p) => p.slug === effective) ?? null;
  const [open, setOpen] = useState(false);

  const navigate = (slug: string) => {
    setOpen(false);
    if (slug === effective) return;
    router.push(onSettings ? `/settings?project=${slug}` : `/projects/${slug}/items`);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          "inline-flex max-w-56 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs text-foreground",
          "hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
        aria-label="Switch project"
      >
        {current ? (
          <>
            <Badge variant="outline" className="shrink-0 px-1.5 py-0">
              {current.providerKind.replace("_", " ")}
            </Badge>
            <span className="truncate font-medium" title={current.name}>
              {current.name}
            </span>
          </>
        ) : (
          <span className="truncate text-muted-foreground">Pick a project</span>
        )}
        <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[20rem] max-w-[calc(100vw-2rem)] gap-0 p-0"
      >
        <Command>
          {projects.length > SEARCH_THRESHOLD ? (
            <CommandInput placeholder="Search projects…" autoFocus />
          ) : null}
          <CommandList>
            <CommandEmpty>No projects match.</CommandEmpty>
            <CommandGroup>
              {projects.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`${p.name} ${p.providerKind}`}
                  data-checked={p.slug === effective}
                  onSelect={() => navigate(p.slug)}
                >
                  <Badge variant="outline" className="shrink-0">
                    {p.providerKind.replace("_", " ")}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate" title={p.name}>
                    {p.name}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="add-project"
                onSelect={() => {
                  setOpen(false);
                  router.push("/settings?section=projects");
                }}
              >
                <FolderPlus aria-hidden="true" className="text-muted-foreground" />
                Add or manage projects
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
