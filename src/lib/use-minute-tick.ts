"use client";

import { useSyncExternalStore } from "react";

/**
 * Shared minute-resolution tick. One `setInterval` for the whole document
 * regardless of how many components subscribe — important for dense
 * backlogs where 50+ `FreshnessStamp`s would otherwise each schedule their
 * own 60s timer.
 *
 * Returns the current snapshot (`Date.now()` of the last tick) so React
 * re-renders subscribers when it changes; consumers don't need to read it.
 */

const listeners = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;
let lastTick = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (intervalId === null) {
    intervalId = setInterval(() => {
      lastTick = Date.now();
      for (const l of listeners) l();
    }, 60_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

function getSnapshot(): number {
  return lastTick;
}

function getServerSnapshot(): number {
  return 0;
}

export function useMinuteTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
