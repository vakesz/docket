"use client";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SelectField } from "@/ui/forms/select-field";

type ProjectOption = {
  id: string;
  name: string;
};

const ADD_PROJECT_VALUE = "__add_project__";

/**
 * Drop-down project switcher in the topbar. Routes into the new project's
 * items shell by default, but when the user is already on `/settings`
 * we stay on /settings and just rebind the active-project query param —
 * switching projects shouldn't kick the user out of settings. On
 * /settings the dropdown also reflects `?project=<id>` so the topbar
 * tracks the page's active project rather than the user's default.
 *
 * The trailing "+ Add project…" option deep-links into the settings
 * Projects panel, the only place users can register a second repo.
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

  return (
    <SelectField
      wrapperClassName="min-w-0 max-w-[12rem]"
      className="truncate rounded-full px-3 py-1 text-xs"
      value={effective}
      onChange={(e) => {
        const next = e.target.value;
        if (next === ADD_PROJECT_VALUE) {
          router.push("/settings?section=projects");
          return;
        }
        if (next && next !== effective) {
          router.push(onSettings ? `/settings?project=${next}` : `/projects/${next}/items`);
        }
      }}
      aria-label="Switch project"
    >
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
      <option disabled value="">
        ──────────
      </option>
      <option value={ADD_PROJECT_VALUE}>+ Add project…</option>
    </SelectField>
  );
}
