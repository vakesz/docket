"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Button } from "@/ui/primitives/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/ui/primitives/tooltip";

const LABELS: Record<string, string> = {
  light: "Light",
  dark: "Dark",
  system: "Auto",
};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  function toggle() {
    const next = theme === "dark" ? "system" : theme === "system" ? "light" : "dark";
    setTheme(next);
  }

  const label = mounted ? (LABELS[theme ?? ""] ?? "Light") : "Theme";
  const Icon = mounted ? (theme === "dark" ? Moon : theme === "system" ? Monitor : Sun) : null;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-xs" onClick={toggle} aria-label="Toggle theme">
            {Icon ? <Icon /> : <span aria-hidden="true" className="inline-block size-4" />}
            <span className="sr-only">Toggle theme</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
