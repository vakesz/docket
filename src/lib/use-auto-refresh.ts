"use client";

/**
 * Resolve the user's `ui.auto-refresh-seconds` setting into the
 * `refetchInterval` shape react-query expects (false = disabled, otherwise
 * milliseconds). One spot so list panels can opt in with a single import
 * instead of re-deriving the conversion each time.
 */

import { trpc } from "@/lib/trpc-client";

export function useAutoRefreshIntervalMs(): number | false {
  const list = trpc.settings.list.useQuery();
  const raw = list.data?.find((r) => r.key === "ui.auto-refresh-seconds")?.value;
  const seconds = typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
  return seconds > 0 ? seconds * 1000 : false;
}
