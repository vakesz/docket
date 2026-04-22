import { useEffect, useState } from "react";

const STORAGE_KEY = "docket.theme";

type Mode = "system" | "light" | "dark";

function readStoredMode(): Mode {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "light" || stored === "dark" ? stored : "system";
}

function applyMode(mode: Mode): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const isDark =
    mode === "dark" ||
    (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", isDark);
}

export function ThemeToggle() {
  // Start with `system` so SSR and first client paint agree; the inline script
  // in __root.tsx has already applied the real class to <html>. The effect
  // below then loads the user's override (if any).
  const [mode, setMode] = useState<Mode>("system");

  useEffect(() => {
    setMode(readStoredMode());
  }, []);

  useEffect(() => {
    applyMode(mode);
    if (mode === "system") {
      window.localStorage.removeItem(STORAGE_KEY);
      const mql = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => applyMode("system");
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    window.localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const next: Mode = mode === "system" ? "light" : mode === "light" ? "dark" : "system";
  const label = mode === "system" ? "Auto" : mode === "dark" ? "Dark" : "Light";

  return (
    <button
      type="button"
      onClick={() => setMode(next)}
      title={`Theme: ${label} — click for ${next}`}
      className="rounded border border-zinc-200 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900"
    >
      {label}
    </button>
  );
}
