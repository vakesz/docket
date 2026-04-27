"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { ActiveProjectPicker } from "@/ui/settings/active-project-picker";
import { GROUPS, SECTIONS, type SectionKey } from "@/ui/settings/sections";

export function SettingsSidebar({
  active,
  onSelect,
  projectId,
}: {
  active: SectionKey;
  onSelect: (key: SectionKey) => void;
  projectId: string | null;
}) {
  const grouped = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        sections: SECTIONS.filter((s) => s.group === g.key),
      })),
    [],
  );

  return (
    <nav className="flex flex-col gap-4">
      {grouped.map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          <div className="px-3 pb-1 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-fg-muted">
            {group.label}
          </div>
          {group.key === "project" ? (
            <div className="px-3 pb-2">
              <ActiveProjectPicker currentProjectId={projectId} />
            </div>
          ) : null}
          {group.sections.map((section) => {
            const Icon = section.icon;
            const isActive = section.key === active;
            const disabled = Boolean(section.needsProject) && !projectId;
            return (
              <button
                key={section.key}
                type="button"
                onClick={() => {
                  if (disabled) return;
                  onSelect(section.key);
                }}
                disabled={disabled}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors",
                  isActive ? "bg-accent/10 text-accent" : "text-fg hover:bg-surface-alt",
                  disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
                )}
                title={disabled ? "Pick a project above to enable" : undefined}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className="flex-1 truncate font-medium">{section.label}</span>
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
