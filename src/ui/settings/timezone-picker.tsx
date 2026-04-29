"use client";

import { Check, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/primitives/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/ui/primitives/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/primitives/popover";

/**
 * Searchable IANA time-zone picker. Empty value (`""`) is the "follow the
 * browser" sentinel and renders as a synthetic top-of-list entry showing
 * the resolved browser zone. Persisted values that aren't in
 * `Intl.supportedValuesOf("timeZone")` (legacy aliases like `Asia/Calcutta`)
 * stay visible as a one-off entry so the user can see what's saved.
 *
 * The zone list and offset map are computed once at module load — DST drift
 * during a session is cosmetic.
 */

type Zone = { id: string; offset: string };

const BROWSER_SENTINEL = "__browser";

const BROWSER_ZONE: string = (() => {
  if (typeof Intl === "undefined") return "UTC";
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
})();

function offsetFor(zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    const tzn = parts.find((p) => p.type === "timeZoneName")?.value;
    if (!tzn) return "";
    // Normalize: "GMT" → "UTC", "GMT+2" → "UTC+02:00".
    if (tzn === "GMT" || tzn === "UTC") return "UTC";
    const m = tzn.match(/^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/);
    if (!m) return tzn;
    const sign = m[1];
    const hh = m[2].padStart(2, "0");
    const mm = m[3] ?? "00";
    return `UTC${sign}${hh}:${mm}`;
  } catch {
    return "";
  }
}

const SUPPORTED_ZONES: readonly Zone[] = (() => {
  if (typeof Intl === "undefined" || typeof Intl.supportedValuesOf !== "function") {
    return [{ id: "UTC", offset: "UTC" }];
  }
  try {
    const ids = Intl.supportedValuesOf("timeZone");
    return ids.map((id) => ({ id, offset: offsetFor(id) }));
  } catch {
    return [{ id: "UTC", offset: "UTC" }];
  }
})();

const SUPPORTED_IDS = new Set(SUPPORTED_ZONES.map((z) => z.id));

function entryLabel(zone: Zone): string {
  return zone.offset ? `${zone.id} — ${zone.offset}` : zone.id;
}

function browserLabel(): string {
  return `Browser local — ${BROWSER_ZONE}`;
}

export function TimezonePicker({
  id,
  value,
  disabled,
  onChange,
}: {
  id?: string;
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);

  const candidates = useMemo<Zone[]>(() => {
    // If the persisted value is non-empty and not in the runtime's list,
    // surface it so the user sees what's currently saved.
    if (value !== "" && !SUPPORTED_IDS.has(value)) {
      return [{ id: value, offset: offsetFor(value) }, ...SUPPORTED_ZONES];
    }
    return SUPPORTED_ZONES.slice();
  }, [value]);

  const selectedLabel =
    value === "" ? browserLabel() : entryLabel({ id: value, offset: offsetFor(value) });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Display time zone"
          disabled={disabled}
          className={cn("w-full max-w-md justify-between font-normal")}
        >
          <span className="truncate">{selectedLabel}</span>
          <ChevronDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
        <Command>
          <CommandInput placeholder="Search time zones…" />
          <CommandList className="max-h-64">
            <CommandEmpty>No matches.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={BROWSER_SENTINEL}
                onSelect={() => {
                  onChange("");
                  setOpen(false);
                }}
                data-checked={value === ""}
              >
                <span className="truncate">{browserLabel()}</span>
                {value === "" ? (
                  <Check aria-hidden className="ml-auto size-4 text-primary" />
                ) : null}
              </CommandItem>
              {candidates.map((zone) => (
                <CommandItem
                  key={zone.id}
                  value={`${zone.id} ${zone.offset}`}
                  onSelect={() => {
                    onChange(zone.id);
                    setOpen(false);
                  }}
                  data-checked={value === zone.id}
                >
                  <span className="truncate font-mono text-xs">{zone.id}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {zone.offset ? (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {zone.offset}
                      </span>
                    ) : null}
                    {value === zone.id ? (
                      <Check aria-hidden className="size-4 text-primary" />
                    ) : null}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
