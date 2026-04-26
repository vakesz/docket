/**
 * Shared draft state for the first-time setup wizard.
 *
 * Mirrors the WizardState dataclass in `src/docket/config/setup_wizard.py`
 * one field at a time so the same defaults survive a CLI ↔ web swap.
 */
import type { DTO } from "~/api/client";

export interface ScopeDraft {
  team: string;
  area_path: string;
  iteration_path: string;
  assignee: string;
}

export interface ProviderDraft {
  key: string;
  type: string;
  display_name: string;
  display_name_dirty: boolean;
  config: Record<string, string>;
  scope: ScopeDraft;
}

export interface LlmDraft {
  endpoint: string;
  api_key: string;
  deployment: string;
  api_version: string;
  price_input_per_1m: string;
  price_output_per_1m: string;
  /** Tracks whether the user has hand-edited prices. Until they do, switching
   * deployments auto-refills with the known Azure Foundry list price. */
  prices_dirty: boolean;
  skip: boolean;
}

export interface SettingsDraft {
  http_bind: string;
  http_port: number;
  telemetry_enabled: boolean;
  telemetry_level: DTO["TelemetryLevel"];
  run_initial_sync: boolean;
}

// Azure Foundry list prices per 1M tokens for known deployments. Mirrors
// `KNOWN_MODEL_PRICES` in src/docket/config/setup_wizard.py.
export const KNOWN_MODEL_PRICES: Record<string, { input: string; output: string }> = {
  "gpt-5": { input: "1.25", output: "10.00" },
  "gpt-5-mini": { input: "0.25", output: "2.00" },
  "gpt-5-nano": { input: "0.05", output: "0.40" },
};

export function defaultPricesFor(deployment: string): { input: string; output: string } | null {
  return KNOWN_MODEL_PRICES[deployment.trim().toLowerCase()] ?? null;
}

export function emptyScope(): ScopeDraft {
  return { team: "", area_path: "", iteration_path: "", assignee: "" };
}

/** Convert a ScopeDraft to the wire shape consumed by `SetupCompleteRequest`.
 * Empty strings become absent so ScopeFilter validation treats each axis as
 * unconstrained — matches the CLI wizard's "blank for any" UX. */
export function scopeToWire(scope: ScopeDraft, type: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (type === "azure_devops") {
    if (scope.team) out.team = scope.team;
    if (scope.area_path) out.area_path = scope.area_path;
    if (scope.iteration_path) out.iteration_path = scope.iteration_path;
  }
  if (scope.assignee) out.assignee = scope.assignee;
  return out;
}

export type Step =
  | "welcome"
  | "cli"
  | "provider"
  | "scope"
  | "llm"
  | "settings"
  | "review"
  | "done";
