/**
 * Pattern (regex) guardrail.
 *
 * Cheapest line of defense. Scans tool results for known prompt-injection
 * shapes — "ignore previous instructions", forged system prompts, smuggled
 * chat-template markers, dangerous URL schemes, oversized base64 blobs.
 * Runs locally with no network round-trip, so it sits in front of any
 * LLM-judge layer in the composite adapter.
 *
 * False positives are tolerable in `flag` mode; only `block` on the
 * `blockOnInjection` setting plus a high-confidence pattern. Input and
 * output checks are deliberately conservative — pattern guardrails on
 * user-typed text annoy the user when over-eager.
 */

import type { CheckToolResultArgs, Guardrail, GuardrailDecision } from "@/agent/guardrail/types";
import { stringifyToolResult } from "@/agent/guardrail/types";

type PatternRule = {
  /** Stable id surfaced in the guardrail reason. */
  id: string;
  pattern: RegExp;
  /** When true, escalates to `block` if `blockOnInjection` is enabled. */
  highConfidence: boolean;
};

/**
 * Tool-result rules — the high-value surface. Order doesn't matter; the
 * adapter returns on the first match.
 */
const TOOL_RESULT_RULES: readonly PatternRule[] = [
  {
    id: "ignore-previous-instructions",
    // "ignore (all|previous|above) instructions", "disregard prior", etc.
    pattern: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+instructions?\b/i,
    highConfidence: true,
  },
  {
    id: "forged-system-prompt",
    // "system: you are now ...", "developer prompt:", etc.
    pattern: /\b(system|developer)\s+(prompt|message|instructions?)\s*[:=]/i,
    highConfidence: true,
  },
  {
    id: "role-coercion",
    // "you are now an admin", "pretend to be the developer", common DAN/jailbreak openers.
    pattern:
      /\b(you\s+are\s+now|pretend\s+to\s+be|act\s+as)\s+.{0,40}\b(admin|root|developer|dan|jailbreak)\b/i,
    highConfidence: true,
  },
  {
    id: "chat-template-marker",
    // OpenAI / Llama chat-template markers leaking through.
    pattern: /<\|(?:im_(?:start|end)|start_header_id|end_header_id|system|user|assistant)\|>/,
    highConfidence: true,
  },
  {
    id: "dangerous-url-scheme",
    // markdown links pointing at javascript: / data: payloads
    pattern: /\]\(\s*(?:javascript|data):/i,
    highConfidence: false,
  },
  {
    id: "oversized-base64-blob",
    // Bare base64 blobs longer than 2KB often hide payloads. Crude but cheap.
    pattern: /[A-Za-z0-9+/]{2048,}={0,2}/,
    highConfidence: false,
  },
];

/**
 * Input rules — only catch the most obvious "I'm trying to break the
 * system prompt" shapes. We don't want to block legitimate user questions
 * about prompts.
 */
const INPUT_RULES: readonly PatternRule[] = [
  {
    id: "ignore-previous-instructions",
    pattern: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+instructions?\b/i,
    highConfidence: false,
  },
  {
    id: "forged-system-prompt",
    pattern: /\b(system|developer)\s+(prompt|message|instructions?)\s*[:=]/i,
    highConfidence: false,
  },
];

export type PatternGuardrailConfig = {
  /** When true, high-confidence matches return `block` instead of `flag`. */
  blockOnInjection: boolean;
};

export class PatternGuardrail implements Guardrail {
  readonly kind = "pattern" as const;
  readonly label = "Pattern guardrail";
  private readonly blockOnInjection: boolean;

  constructor(config: PatternGuardrailConfig) {
    this.blockOnInjection = config.blockOnInjection;
  }

  async checkInput(text: string): Promise<GuardrailDecision> {
    const hit = match(text, INPUT_RULES);
    if (!hit) return { action: "allow" };
    // Input rules never block — only flag — so we don't refuse legitimate
    // questions like "what's in your system prompt?".
    return { action: "flag", reason: `pattern: ${hit.id}`, categories: [hit.id] };
  }

  async checkToolResult(args: CheckToolResultArgs): Promise<GuardrailDecision> {
    const text = args.untrusted !== undefined ? args.untrusted : stringifyToolResult(args.result);
    if (!text) return { action: "allow" };
    const hit = match(text, TOOL_RESULT_RULES);
    if (!hit) return { action: "allow" };
    if (hit.highConfidence && this.blockOnInjection) {
      return { action: "block", reason: `pattern: ${hit.id}`, categories: [hit.id] };
    }
    return { action: "flag", reason: `pattern: ${hit.id}`, categories: [hit.id] };
  }

  async checkOutput(text: string): Promise<GuardrailDecision> {
    // Output pattern checks are deliberately a no-op. Pattern matches on
    // assistant prose produce too many false positives (the agent quotes
    // user input back, etc.). Use the moderation adapter for output.
    void text;
    return { action: "allow" };
  }
}

function match(text: string, rules: readonly PatternRule[]): PatternRule | null {
  for (const rule of rules) {
    if (rule.pattern.test(text)) return rule;
  }
  return null;
}
