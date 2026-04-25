import { MODE_STORAGE_KEY, SECTIONS } from "./_constants";
import type { ConfigMap, Mode, SectionKey } from "./_types";

export function readPersistedMode(): Mode {
  if (typeof window === "undefined") return "form";
  try {
    const v = window.localStorage.getItem(MODE_STORAGE_KEY);
    return v === "raw" ? "raw" : "form";
  } catch {
    return "form";
  }
}

export function asRecord(value: unknown): ConfigMap | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ConfigMap) : null;
}

export function getString(record: ConfigMap | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function getBoolean(record: ConfigMap | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === "boolean" ? value : null;
}

export function getNumberValue(record: ConfigMap | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function cloneSection(value: unknown): ConfigMap {
  const rec = asRecord(value);
  return rec ? JSON.parse(JSON.stringify(rec)) : {};
}

export function setOrUnset(map: ConfigMap, key: string, value: string): ConfigMap {
  if (value === "") {
    const { [key]: _omit, ...rest } = map;
    return rest;
  }
  return { ...map, [key]: value };
}

export function providerLabel(entry: unknown, key: string): string {
  const rec = asRecord(entry);
  const display = rec ? getString(rec, "display_name") : null;
  const type = rec ? getString(rec, "type") : null;
  if (display && type) return `${display} (${type})`;
  if (display) return display;
  return key;
}

export function makeRowId(seed: string): string {
  return `${seed}-${Math.random().toString(36).slice(2, 8)}`;
}

export function parseRawDraft(draft: string): { value: ConfigMap | null; error: string | null } {
  if (!draft.trim()) {
    return { value: null, error: "The config editor cannot be empty." };
  }
  try {
    const parsed = JSON.parse(draft) as unknown;
    const record = asRecord(parsed);
    if (!record) {
      return { value: null, error: "The top-level config must stay a JSON object." };
    }
    return { value: record, error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// Build a minimal patch object from per-section drafts. Only sections the user
// actually touched (i.e. differ from the initial config, ignoring our synthetic
// `_active` key) are included. The `providers._active` synthetic key is hoisted
// to the top-level `active_provider` field.
export function buildFormPatch(
  drafts: Partial<Record<SectionKey, ConfigMap>>,
  initialConfig: ConfigMap,
): ConfigMap {
  const out: ConfigMap = {};

  for (const meta of SECTIONS) {
    const draft = drafts[meta.key];
    if (!draft) continue;

    if (meta.key === "providers") {
      if ("_active" in draft) {
        const active = String(draft._active ?? "");
        if (active !== (getString(initialConfig, "active_provider") ?? "")) {
          out.active_provider = active;
        }
      }
      const baseProviders = asRecord(initialConfig.providers) ?? {};
      const draftProviders = asRecord(draft.providers);
      if (draftProviders && JSON.stringify(draftProviders) !== JSON.stringify(baseProviders)) {
        out.providers = draftProviders;
      }
      continue;
    }

    const base = asRecord(initialConfig[meta.key]) ?? {};
    if (JSON.stringify(draft) !== JSON.stringify(base)) {
      out[meta.key] = draft;
    }
  }

  return out;
}

export function deepMerge(base: ConfigMap, patch: ConfigMap): ConfigMap {
  const out: ConfigMap = JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(patch)) {
    const baseValue = out[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      baseValue &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue)
    ) {
      out[key] = deepMerge(baseValue as ConfigMap, value as ConfigMap);
    } else {
      out[key] = value;
    }
  }
  return out;
}
