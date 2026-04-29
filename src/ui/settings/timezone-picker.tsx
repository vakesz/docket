"use client";

import {
  Combobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from "@headlessui/react";
import { Check, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { fieldClass } from "@/lib/form-classes";
import { cn } from "@/lib/utils";

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
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (next: string) => void;
}) {
  const [query, setQuery] = useState("");

  const candidates = useMemo<Zone[]>(() => {
    // If the persisted value is non-empty and not in the runtime's list,
    // surface it so the user sees what's currently saved.
    if (value !== "" && !SUPPORTED_IDS.has(value)) {
      return [{ id: value, offset: offsetFor(value) }, ...SUPPORTED_ZONES];
    }
    return SUPPORTED_ZONES.slice();
  }, [value]);

  const filtered = useMemo<Zone[]>(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return candidates;
    return candidates.filter(
      (z) => z.id.toLowerCase().includes(q) || z.offset.toLowerCase().includes(q),
    );
  }, [candidates, query]);

  const selectedLabel =
    value === "" ? browserLabel() : entryLabel({ id: value, offset: offsetFor(value) });

  return (
    <Combobox
      value={value}
      onChange={(next: string | null) => {
        onChange(next ?? "");
        setQuery("");
      }}
      disabled={disabled}
    >
      <div className="relative max-w-md">
        <ComboboxInput
          aria-label="Display time zone"
          autoComplete="off"
          spellCheck={false}
          className={cn(fieldClass, "pr-9")}
          displayValue={() => selectedLabel}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setQuery("")}
        />
        <ComboboxButton className="absolute inset-y-0 right-0 flex items-center pr-2 text-muted-foreground">
          <ChevronDown aria-hidden className="h-4 w-4" />
        </ComboboxButton>

        <ComboboxOptions
          transition
          className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-xl border border-border bg-card py-1 shadow-lg focus:outline-none data-[closed]:opacity-0"
        >
          <ComboboxOption
            value=""
            className="group flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm text-foreground data-[focus]:bg-muted"
          >
            <span className="truncate">{browserLabel()}</span>
            {value === "" ? <Check aria-hidden className="h-4 w-4 text-primary" /> : null}
          </ComboboxOption>
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-sm text-muted-foreground-faint">No matches.</div>
          ) : (
            filtered.map((zone) => (
              <ComboboxOption
                key={zone.id}
                value={zone.id}
                className="group flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-sm text-foreground data-[focus]:bg-muted"
              >
                <span className="truncate font-mono text-xs">{zone.id}</span>
                <span className="flex shrink-0 items-center gap-2">
                  {zone.offset ? (
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {zone.offset}
                    </span>
                  ) : null}
                  {value === zone.id ? (
                    <Check aria-hidden className="h-4 w-4 text-primary" />
                  ) : null}
                </span>
              </ComboboxOption>
            ))
          )}
        </ComboboxOptions>
      </div>
    </Combobox>
  );
}
