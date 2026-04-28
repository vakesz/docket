/**
 * No-op guardrail — used when guardrail.enabled is off or no guardrail
 * provider is configured. Allows everything through; the loop's hook
 * points become free function calls.
 */

import type { Guardrail, GuardrailDecision } from "@/agent/guardrail/types";

const ALLOW: GuardrailDecision = { action: "allow" };

export class NoopGuardrail implements Guardrail {
  readonly kind = "noop" as const;
  readonly label = "Guardrails disabled";

  async checkInput(): Promise<GuardrailDecision> {
    return ALLOW;
  }
  async checkToolResult(): Promise<GuardrailDecision> {
    return ALLOW;
  }
  async checkOutput(): Promise<GuardrailDecision> {
    return ALLOW;
  }
}
