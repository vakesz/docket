"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/ui/primitives/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/ui/primitives/tooltip";

const LABELS: Record<string, string> = {
  light: "Light",
  dark: "Dark",
  system: "Auto",
};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();

  function toggle() {
    const next = theme === "dark" ? "system" : theme === "system" ? "light" : "dark";
    setTheme(next);
  }

  const label = LABELS[theme ?? ""] ?? "Light";

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-xs" onClick={toggle} aria-label="Toggle theme">
            {theme === "dark" ? <Moon /> : theme === "system" ? <Monitor /> : <Sun />}
            <span className="sr-only">Toggle theme</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
