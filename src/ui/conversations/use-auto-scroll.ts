"use client";

import { type RefObject, useEffect, useRef } from "react";

/**
 * Stick-to-bottom scroll for a streaming transcript. Returns a ref to
 * attach to the scroll viewport; call `bumpDeps` whenever new content
 * lands so the hook re-evaluates whether to scroll.
 *
 * Two responsibilities:
 *  1. Track whether the user is "near the bottom" by listening to the
 *     viewport's scroll events. Crossing the 64px threshold flips the
 *     stick state — once the user scrolls up to read, we stop chasing.
 *  2. Coalesce auto-scrolls into a single rAF tick. SSE chunk arrival
 *     fires many state updates per second; one smooth scroll per chunk
 *     would cancel-restart against an ever-growing scrollHeight, reading
 *     as flicker.
 *
 * The caller drives recomputation by passing a varying `deps` array
 * (number of messages, streaming text length, etc.). When the stream
 * has settled (`done === true`), the scroll is animated; mid-stream it
 * snaps to keep up with token deltas.
 */
const STICK_THRESHOLD_PX = 64;

export function useAutoScroll(
  deps: readonly unknown[],
  done: boolean,
): {
  scrollRef: RefObject<HTMLDivElement | null>;
} {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const frameRef = useRef<number | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottomRef.current = distance < STICK_THRESHOLD_PX;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const node = scrollRef.current;
      if (!node || !stickToBottomRef.current) return;
      node.scrollTo({
        top: node.scrollHeight,
        behavior: done ? "smooth" : "auto",
      });
    });
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [done, ...deps]);

  return { scrollRef };
}
