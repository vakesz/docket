/**
 * `ask_user_question` — the only tool that pauses the loop for a human reply.
 *
 * Most tool calls are read/write side effects: dispatch, run, feed result
 * back, keep going. This one is different — its "result" is the user's
 * answer, which only the chat surface can supply. The handler returns a
 * structured envelope that the agent loop recognises as a hand-off
 * signal: it stops the turn, surfaces the question on the SSE stream,
 * and resumes when the user replies (the reply lands as a regular `user`
 * message; the loop then re-calls the model with the question marked
 * answered).
 *
 * The actual pause/resume choreography lives in the loop, not here. This
 * file only validates and shapes the call.
 */

import "server-only";
import { z } from "zod";
import type { ToolFactory } from "@/agent/tools/types";
import { defineTool, ok } from "@/agent/tools/types";

const QuestionInput = z.object({
  question: z
    .string()
    .min(1)
    .max(1_000)
    .describe("The question to ask the user. Be specific; include why you're asking."),
  options: z
    .array(z.string().min(1).max(200))
    .min(2)
    .max(8)
    .optional()
    .describe(
      "Optional multiple-choice answers. Provide 2-8 specific, exhaustive options when the answer space is closed; omit for free-text.",
    ),
  multi_select: z
    .boolean()
    .default(false)
    .describe("True if more than one option may be selected. Only meaningful when options is set."),
});

export type AskUserQuestionPayload = z.infer<typeof QuestionInput>;

export const askUserQuestionTool: ToolFactory = (_ctx) =>
  defineTool({
    name: "ask_user_question",
    description:
      "Pause and ask the user a question. Use this instead of guessing when you need information that isn't in the conversation, the cached item, or any tool result. Provide multiple-choice options when the answer space is closed.",
    schema: QuestionInput,
    // The result echoes the agent's own question back to the loop so the UI
    // can render it; nothing in this payload originates outside the trust
    // boundary, so the LLM judge would just be classifying our own text.
    guardrailScan: { mode: "skip" },
    handler: async (payload) => {
      return ok({
        kind: "ask_user_question" as const,
        question: payload.question,
        options: payload.options ?? null,
        multi_select: payload.multi_select,
      });
    },
  });

export function questionTools(ctx: Parameters<ToolFactory>[0]) {
  return [askUserQuestionTool(ctx)] as const;
}
