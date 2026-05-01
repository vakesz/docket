"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

type ProjectOption = { id: string; slug: string; name: string };

const CommandPaletteImpl = dynamic(
  () => import("@/ui/shell/command-palette-impl").then((mod) => mod.CommandPaletteImpl),
  {
    // Cmdk + radix Dialog ride along with the impl chunk; nothing to render
    // before the user opens the palette.
    ssr: false,
    loading: () => null,
  },
);

/**
 * Global Cmd/Ctrl+K shell. The keyboard listener lives here so it's live
 * from the moment the layout mounts, but cmdk + the palette body are
 * deferred until the first open — saves ~40 KB off the initial bundle on
 * every project/settings page load.
 *
 * `mounted` flips to `true` on first open and stays true so closing
 * doesn't re-tear-down the chunk. Each subsequent open is instant.
 */
export function CommandPalette({
  projectSlug,
  projects,
}: {
  projectSlug: string;
  projects: ProjectOption[];
}) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setMounted(true);
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!mounted) return null;
  return (
    <CommandPaletteImpl
      projectSlug={projectSlug}
      projects={projects}
      open={open}
      onOpenChange={setOpen}
    />
  );
}
