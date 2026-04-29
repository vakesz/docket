"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";

const LABELS: Record<string, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // `theme` is undefined on the server — next-themes only resolves it after
  // hydration. Gate the picker so SSR and first client paint match.
  useEffect(() => setMounted(true), []);

  const value = mounted ? (theme ?? "system") : "system";

  return (
    <Select value={value} onValueChange={setTheme} disabled={!mounted}>
      <SelectTrigger aria-label="Color theme" className="w-full max-w-xs">
        <SelectValue>{LABELS[value]}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="light">Light</SelectItem>
        <SelectItem value="dark">Dark</SelectItem>
        <SelectItem value="system">System</SelectItem>
      </SelectContent>
    </Select>
  );
}
