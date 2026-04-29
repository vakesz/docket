"use client";

import {
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { Input } from "@/ui/primitives/input";

type Props = Omit<ComponentPropsWithoutRef<"input">, "value" | "onChange" | "type"> & {
  /** Last committed numeric value. The displayed buffer follows this only
   *  while the input is idle, so a server round-trip mid-typing can't snap
   *  the cursor or drop characters. */
  value: number;
  min?: number;
  max?: number;
  /** Fired on blur or Enter when the buffer parses to a different,
   *  in-range integer. Empty / NaN buffers cancel back to {@link value}
   *  instead of firing — avoids the controlled-input quirk where
   *  backspacing the field would silently snap back to the old value. */
  onCommit: (next: number) => void;
};

/**
 * Integer input that commits on blur (or Enter) instead of on every
 * keystroke. The local string buffer makes intermediate states like an
 * empty field or a single digit on the way to a larger number typeable
 * even when the parent re-fetches its value over tRPC between
 * keystrokes. Clamps to `[min, max]` at commit time.
 */
export function NumberField({
  value,
  min,
  max,
  onCommit,
  className,
  inputMode = "numeric",
  onFocus,
  onBlur,
  onKeyDown,
  ...rest
}: Props) {
  const [buffer, setBuffer] = useState(() => String(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setBuffer(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number.parseInt(buffer, 10);
    if (!Number.isFinite(parsed)) {
      setBuffer(String(value));
      return;
    }
    let next = parsed;
    if (typeof min === "number" && next < min) next = min;
    if (typeof max === "number" && next > max) next = max;
    setBuffer(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <Input
      {...rest}
      type="number"
      inputMode={inputMode}
      min={min}
      max={max}
      value={buffer}
      onChange={(e) => setBuffer(e.target.value)}
      onFocus={(e) => {
        focusedRef.current = true;
        onFocus?.(e);
      }}
      onBlur={(e) => {
        focusedRef.current = false;
        commit();
        onBlur?.(e);
      }}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setBuffer(String(value));
          e.currentTarget.blur();
        }
        onKeyDown?.(e);
      }}
      className={className}
    />
  );
}
