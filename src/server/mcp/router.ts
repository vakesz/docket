/**
 * MCP server configuration API.
 *
 * Per-project HTTP-only MCP servers. Stored in `McpServerConfig`; consumed
 * by `src/agent/mcp/tools.ts` when the agent loop builds the tool
 * registry. CRUD only — no live connection management here. The agent
 * connects on demand at registry-build time and closes at loop end, so
 * there's no daemon to keep in sync with the config table.
 *
 * Headers JSON is plain JSON for now; per-row encryption is not yet wired.
 */

import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  projectIdSchema,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  router,
} from "@/server/trpc";

const ServerRef = projectIdSchema.extend({
  serverId: z.string().min(1),
});

const HeadersJson = z.record(z.string(), z.string()).default({});

const CreateInput = projectIdSchema.extend({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase, digits, '-' or '_'"),
  url: z.string().url().max(500),
  headersJson: HeadersJson,
  enabled: z.boolean().default(true),
});

const UpdateInput = ServerRef.extend({
  url: z.string().url().max(500).optional(),
  headersJson: HeadersJson.optional(),
  enabled: z.boolean().optional(),
});

export const mcpRouter = router({
  list: projectScopedProcedure.input(projectIdSchema).query(async ({ ctx }) => {
    return ctx.db.mcpServerConfig.findMany({
      where: { projectId: ctx.projectId },
      orderBy: [{ name: "asc" }],
    });
  }),

  get: projectScopedProcedure.input(ServerRef).query(async ({ ctx, input }) => {
    const row = await ctx.db.mcpServerConfig.findFirst({
      where: { id: input.serverId, projectId: ctx.projectId },
    });
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
    }
    return row;
  }),

  create: projectScopedMutationProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    try {
      return await ctx.db.mcpServerConfig.create({
        data: {
          projectId: ctx.projectId,
          name: input.name,
          transport: "http",
          url: input.url,
          headersJson: input.headersJson,
          enabled: input.enabled,
        },
      });
    } catch (err) {
      // Prisma unique constraint (projectId, name) — surface as a friendly
      // 409 instead of leaking the raw P2002.
      if (err instanceof Error && err.message.includes("Unique constraint")) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `An MCP server named '${input.name}' already exists in this project.`,
        });
      }
      throw err;
    }
  }),

  update: projectScopedMutationProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
    const existing = await ctx.db.mcpServerConfig.findFirst({
      where: { id: input.serverId, projectId: ctx.projectId },
    });
    if (!existing) {
      throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
    }
    return ctx.db.mcpServerConfig.update({
      where: { id: existing.id },
      data: {
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.headersJson !== undefined ? { headersJson: input.headersJson } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
    });
  }),

  delete: projectScopedMutationProcedure.input(ServerRef).mutation(async ({ ctx, input }) => {
    const result = await ctx.db.mcpServerConfig.deleteMany({
      where: { id: input.serverId, projectId: ctx.projectId },
    });
    if (result.count === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
    }
    return { id: input.serverId };
  }),
});
