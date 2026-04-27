"use client";
import { Bot, KeyRound, UserRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { LlmProvidersPanel } from "@/ui/settings/llm-providers-panel";
import { OauthProvidersPanel } from "@/ui/settings/oauth-providers-panel";
import { ProfilePanel } from "@/ui/settings/profile-panel";

type SectionKey = "profile" | "llm-providers" | "oauth-providers";
type SectionGroup = "user" | "deployment";

type SectionMeta = {
  key: SectionKey;
  label: string;
  icon: typeof UserRound;
  group: SectionGroup;
};

const SECTIONS: SectionMeta[] = [
  { key: "profile", label: "Profile", icon: UserRound, group: "user" },
  { key: "llm-providers", label: "LLM providers", icon: Bot, group: "deployment" },
  { key: "oauth-providers", label: "OAuth providers", icon: KeyRound, group: "deployment" },
];

const GROUPS: { key: SectionGroup; label: string }[] = [
  { key: "user", label: "You" },
  { key: "deployment", label: "Deployment" },
];

const STORAGE_KEY = "docket.settings.section";

function readPersistedSection(): SectionKey {
  if (typeof window === "undefined") return "profile";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v && SECTIONS.some((s) => s.key === v)) {
      return v as SectionKey;
    }
  } catch {
    // ignore
  }
  return "profile";
}

/**
 * Unified settings page. One route, sidebar nav, content pane — mirrors
 * main's `SettingsPage` shape so users moving between the two surfaces
 * find the same vocabulary. Active section persists in localStorage so a
 * refresh doesn't kick the user back to "Profile".
 */
export function SettingsShell({ publicBase }: { publicBase: string }) {
  const [active, setActive] = useState<SectionKey>("profile");

  useEffect(() => {
    setActive(readPersistedSection());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, active);
    } catch {
      // ignore
    }
  }, [active]);

  const grouped = useMemo(
    () =>
      GROUPS.map((g) => ({
        ...g,
        sections: SECTIONS.filter((s) => s.group === g.key),
      })),
    [],
  );

  return (
    <div className="grid min-h-0 w-full flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-auto border-b border-border bg-surface/80 px-3 py-4 lg:border-b-0 lg:border-r">
        <nav className="flex flex-col gap-4">
          {grouped.map((group) => (
            <div key={group.key} className="flex flex-col gap-1">
              <div className="px-3 pb-1 font-mono text-[10px] font-medium uppercase tracking-[0.18em] text-fg-muted">
                {group.label}
              </div>
              {group.sections.map((section) => {
                const Icon = section.icon;
                const isActive = section.key === active;
                return (
                  <button
                    key={section.key}
                    type="button"
                    onClick={() => setActive(section.key)}
                    className={cn(
                      "flex items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors",
                      isActive ? "bg-accent/10 text-accent" : "text-fg hover:bg-surface-alt",
                    )}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="flex-1 truncate font-medium">{section.label}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      <section className="min-h-0 overflow-auto p-6">
        {active === "profile" ? <ProfilePanel /> : null}
        {active === "llm-providers" ? <LlmProvidersPanel /> : null}
        {active === "oauth-providers" ? <OauthProvidersPanel publicBase={publicBase} /> : null}
      </section>
    </div>
  );
}
