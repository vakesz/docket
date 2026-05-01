/**
 * Vendor-neutral judge client for `LlmJudgeGuardrail`.
 *
 * The guardrail owns the prompt-engineering choices (three-class verdicts,
 * self-consistency on injection, the system prompts) and only needs a way
 * to post a single-shot single-token classification request to whatever
 * LLM the operator configured. Each LLM kind ships its own `JudgeClient`
 * implementation alongside its chat adapter under `src/agent/llm/<kind>.ts`;
 * `selectGuardrailFor` picks the right one based on `LlmProvider.kind`.
 *
 * Architecture rule: the SDK quarantine in
 * `src/__arch__/no-llm-vendor-leak.test.ts` forbids vendor SDK imports
 * outside the per-kind adapter file — the judge client implementations
 * live there for that reason. The guardrail itself imports only this
 * interface.
 */

export interface JudgeClient {
  /**
   * Model id from the underlying `LlmProvider` row. Used in log lines and
   * surfaced through the guardrail's `label`; the guardrail never uses it
   * for control flow.
   */
  readonly model: string;

  /**
   * One classification round-trip. Implementations send `system` + `user`
   * to the vendor's chat-style API and return the model's raw output text
   * along with token usage when surfaced. Failures should throw so the
   * guardrail can map them to its log + allow-by-default policy.
   */
  classify(args: JudgeClassifyArgs): Promise<JudgeClassifyResult>;
}

export type JudgeClassifyArgs = {
  /** System message — verdict instructions, label inventory. */
  system: string;
  /** User message — content to classify (already truncated by the caller). */
  user: string;
  signal?: AbortSignal;
};

export type JudgeClassifyResult = {
  /** Raw output text, untrimmed. The guardrail does its own label match. */
  text: string;
  /**
   * Optional token usage. When the vendor surfaces it, the guardrail folds
   * it into the conversation's `guardrailTokens*` columns.
   */
  usage?: { tokensIn: number; tokensOut: number };
};
