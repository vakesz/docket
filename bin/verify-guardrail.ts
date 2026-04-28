import { db } from "@/server/db";

async function main() {
  const providers = await db.llmProvider.findMany({
    select: { id: true, role: true, enabled: true, model: true, isDefault: true, label: true },
    orderBy: [{ role: "asc" }, { isDefault: "desc" }, { updatedAt: "desc" }],
  });
  console.log("=== LlmProvider rows ===");
  console.table(providers);

  const guardrailKeys = [
    "guardrail.enabled",
    "guardrail.kind",
    "guardrail.block-on-injection",
    "guardrail.block-off-topic",
    "guardrail.scope-check-enabled",
    "guardrail.output-check-enabled",
  ];
  const settings = await db.setting.findMany({
    where: { key: { in: guardrailKeys } },
    select: { key: true, projectId: true, value: true },
    orderBy: [{ projectId: "asc" }, { key: "asc" }],
  });
  console.log("\n=== Guardrail Setting rows (only overrides; absent = catalog default) ===");
  console.table(settings);

  const projects = await db.project.findMany({
    select: { id: true, name: true, defaultGuardrailProviderId: true, defaultLlmProviderId: true },
  });
  console.log("\n=== Project rows (guardrail provider pin) ===");
  console.table(projects);

  const recent = await db.message.findMany({
    where: { role: "user" },
    select: {
      id: true,
      conversationId: true,
      createdAt: true,
      flagged: true,
      guardrailReason: true,
      content: true,
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });
  console.log("\n=== Last 5 user messages (look for the pancake one) ===");
  console.table(
    recent.map((r) => ({
      id: r.id,
      convo: r.conversationId.slice(0, 8),
      at: r.createdAt.toISOString(),
      flagged: r.flagged,
      reason: r.guardrailReason ?? "(none)",
      preview: (typeof r.content === "string" ? r.content : JSON.stringify(r.content)).slice(0, 80),
    })),
  );

  const convo = await db.conversation.findUnique({
    where: { id: "cmoj6f5o" + (await findConvoSuffix()) },
    select: {
      id: true,
      projectId: true,
      guardrailTokensIn: true,
      guardrailTokensOut: true,
      guardrailCostCents: true,
    },
  });
  console.log("\n=== Pancake conversation guardrail usage counters ===");
  console.table(convo ? [convo] : []);

  await db.$disconnect();
}

async function findConvoSuffix(): Promise<string> {
  const c = await db.conversation.findFirst({
    where: { id: { startsWith: "cmoj6f5o" } },
    select: { id: true },
  });
  return c ? c.id.slice(8) : "";
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
