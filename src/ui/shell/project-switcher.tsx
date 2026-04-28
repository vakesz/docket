"use client";
import {
  CloseButton,
  Combobox,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
  Popover,
  PopoverButton,
  PopoverPanel,
} from "@headlessui/react";
import { Check, ChevronDown, FolderPlus } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { badgeClass, metaLabelFaintClass } from "@/lib/form-classes";
import { cn } from "@/lib/utils";

type ProjectOption = {
  id: string;
  name: string;
  providerKind: string;
};

const SEARCH_THRESHOLD = 5;

/**
 * Single source of truth for switching projects across the chrome. Lives
 * in the topbar; identical behavior on items and settings.
 *
 * On `/settings` the trigger reflects `?project=<id>` (the page's active
 * project) rather than the user's pinned default, and switching just
 * rebinds the query so the user keeps the same settings section. Anywhere
 * else, switching navigates to `/projects/<id>/items`.
 *
 * The popover footer carries the "Add project" deep-link so it stays a
 * real button (not a sentinel `<option>`) — keyboard + screen-reader
 * users get correct semantics.
 */
export function ProjectSwitcher({
  projects,
  currentProjectId,
}: {
  projects: ProjectOption[];
  currentProjectId: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const onSettings = pathname?.startsWith("/settings") ?? false;

  const urlProject = onSettings ? searchParams.get("project") : null;
  const effective =
    urlProject && projects.some((p) => p.id === urlProject) ? urlProject : currentProjectId;

  const current = projects.find((p) => p.id === effective) ?? null;
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.providerKind.replace("_", " ").toLowerCase().includes(q),
    );
  }, [query, projects]);

  const navigate = (id: string) => {
    if (id === effective) return;
    router.push(onSettings ? `/settings?project=${id}` : `/projects/${id}/items`);
  };

  return (
    <Popover className="relative">
      <PopoverButton
        className={cn(
          "inline-flex max-w-[14rem] items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs text-fg",
          "hover:bg-surface-alt focus:outline-none focus:ring-2 focus:ring-accent",
        )}
        aria-label="Switch project"
      >
        {current ? (
          <>
            <span className={cn(badgeClass, "shrink-0 px-1.5 py-0")}>
              {current.providerKind.replace("_", " ")}
            </span>
            <span className="truncate font-medium" title={current.name}>
              {current.name}
            </span>
          </>
        ) : (
          <span className="truncate text-fg-muted">Pick a project</span>
        )}
        <ChevronDown aria-hidden="true" className="h-3 w-3 shrink-0 text-fg-muted" />
      </PopoverButton>
      <PopoverPanel
        anchor={{ to: "bottom end", gap: 8 }}
        transition
        className={cn(
          "z-30 w-[20rem] max-w-[calc(100vw-2rem)] origin-top-right overflow-hidden rounded-xl border border-border bg-surface text-fg shadow-lg",
          "transition data-closed:scale-95 data-closed:opacity-0 data-enter:duration-100 data-enter:ease-out data-leave:duration-75 data-leave:ease-in",
          "focus:outline-none",
        )}
      >
        {({ close }) => (
          <>
            <Combobox<ProjectOption | null>
              immediate
              value={null}
              onChange={(p) => {
                if (!p) return;
                close();
                setQuery("");
                navigate(p.id);
              }}
            >
              {projects.length > SEARCH_THRESHOLD ? (
                <ComboboxInput
                  placeholder="Search projects…"
                  className="w-full border-b border-border bg-transparent px-3 py-2 text-sm text-fg outline-none"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  displayValue={() => query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              ) : null}
              <ComboboxOptions static className="max-h-[18rem] overflow-auto p-1">
                {filtered.length === 0 ? (
                  <div className={cn("px-3 py-4 text-center", metaLabelFaintClass)}>
                    No projects match.
                  </div>
                ) : (
                  filtered.map((p) => (
                    <ComboboxOption
                      key={p.id}
                      value={p}
                      className="flex cursor-pointer items-center gap-2 rounded px-3 py-2 text-sm data-focus:bg-surface-alt"
                    >
                      <span className={cn(badgeClass, "shrink-0")}>
                        {p.providerKind.replace("_", " ")}
                      </span>
                      <span className="min-w-0 flex-1 truncate" title={p.name}>
                        {p.name}
                      </span>
                      {p.id === effective ? (
                        <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent" />
                      ) : null}
                    </ComboboxOption>
                  ))
                )}
              </ComboboxOptions>
            </Combobox>
            <CloseButton
              as="button"
              type="button"
              onClick={() => {
                setQuery("");
                router.push("/settings?section=projects");
              }}
              className="flex w-full items-center gap-2 border-t border-border bg-surface-alt/40 px-3 py-2 text-left text-sm text-fg hover:bg-surface-alt"
            >
              <FolderPlus aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
              Add or manage projects
            </CloseButton>
          </>
        )}
      </PopoverPanel>
    </Popover>
  );
}
