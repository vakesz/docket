import { useEffect, useState } from "react";

const STORAGE_KEY = "docket.theme";

type Mode = "light" | "dark";

function readInitial(): Mode {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("light");

  useEffect(() => {
    setMode(readInitial());
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("dark", mode === "dark");
    window.localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  return (
    <button
      type="button"
      onClick={() => setMode(mode === "dark" ? "light" : "dark")}
      title={`Switch to ${mode === "dark" ? "light" : "dark"} mode`}
      className="rounded border border-zinc-200 px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-zinc-600 hover:bg-zinc-100 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900"
    >
      {mode === "dark" ? "Dark" : "Light"}
    </button>
  );
}
