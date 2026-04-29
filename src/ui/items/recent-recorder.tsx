"use client";

import { useEffect } from "react";
import { recordRecentItem } from "@/lib/recent-items";

/**
 * Mount inside the item detail pane so visiting an item records it as
 * recent for the surrounding backlog. Renders nothing.
 */
export function RecentRecorder({
  projectSlug,
  itemNumber,
}: {
  projectSlug: string;
  itemNumber: string;
}) {
  useEffect(() => {
    recordRecentItem(projectSlug, itemNumber);
  }, [projectSlug, itemNumber]);
  return null;
}
