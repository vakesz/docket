import "server-only";
import type { Conversation, LlmProvider, Project } from "@/db/generated/client";
import type { db } from "@/server/db";

/**
 * Resolve which `LlmProvider` row should drive the agent for a given
 * conversation, applying the documented fallback chain:
 *
 *   conversation.llmProviderIdOverride
 *     → project.defaultLlmProviderId
 *     → the deployment-wide chat row (`role='chat'`, `isDefault=true`).
 *
 * Every step filters `role: 'chat'` so a guardrail row can never resolve
 * here even when some malformed pointer references one. Returns null when
 * no row at all is configured (setup wizard hasn't run). `selectAdapterFor`
 * instantiates the actual adapter from this row.
 */
export async function resolveLlmProviderRow(
  prisma: typeof db,
  project: Pick<Project, "id" | "defaultLlmProviderId">,
  conversation?: Pick<Conversation, "llmProviderIdOverride"> | null,
): Promise<LlmProvider | null> {
  if (conversation?.llmProviderIdOverride) {
    const row = await prisma.llmProvider.findFirst({
      where: { id: conversation.llmProviderIdOverride, role: "chat", enabled: true },
    });
    if (row) return row;
  }
  if (project.defaultLlmProviderId) {
    const row = await prisma.llmProvider.findFirst({
      where: { id: project.defaultLlmProviderId, role: "chat", enabled: true },
    });
    if (row) return row;
  }
  return prisma.llmProvider.findFirst({
    where: { role: "chat", isDefault: true, enabled: true },
  });
}
