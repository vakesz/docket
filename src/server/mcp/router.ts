/**
 * MCP server configuration API.
 *
 * Per-project HTTP-only MCP servers. Stored in `McpServerConfig`; consumed
 * by `src/agent/mcp/tools.ts` when the agent loop builds the tool
 * registry. CRUD only — no live connection management here. The agent
 * connects on demand at registry-build time and closes at loop end, so
 * there's no daemon to keep in sync with the config table.
 *
 * Headers are encrypted at rest via `headers-codec.ts` (single `_enc`
 * blob per row). OAuth flow lives in `./oauth/router.ts` and stamps
 * `Authorization: Bearer <token>` into the same headers map after a
 * successful exchange.
 */

import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { Prisma } from "@/db/generated/client";
import { decodeHeaders, encodeHeaders } from "@/server/mcp/headers-codec";
import { mcpOauthRouter } from "@/server/mcp/oauth/router";
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

type ConfigRow = {
  id: string;
  projectId: string;
  name: string;
  transport: string;
  url: string;
  headersJson: Prisma.JsonValue;
  enabled: boolean;
  oauthIssuer: string | null;
  oauthAccessExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function shapeRow(row: ConfigRow) {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    transport: row.transport,
    url: row.url,
    headersJson: decodeHeaders(row.headersJson),
    enabled: row.enabled,
    hasOauth: row.oauthIssuer !== null,
    oauthAccessExpiresAt: row.oauthAccessExpiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export const mcpRouter = router({
  list: projectScopedProcedure.input(projectIdSchema).query(async ({ ctx }) => {
    const rows = await ctx.db.mcpServerConfig.findMany({
      where: { projectId: ctx.projectId },
      orderBy: [{ name: "asc" }],
    });
    return rows.map(shapeRow);
  }),

  get: projectScopedProcedure.input(ServerRef).query(async ({ ctx, input }) => {
    const row = await ctx.db.mcpServerConfig.findFirst({
      where: { id: input.serverId, projectId: ctx.projectId },
    });
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
    }
    return shapeRow(row);
  }),

  create: projectScopedMutationProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    try {
      const row = await ctx.db.mcpServerConfig.create({
        data: {
          projectId: ctx.projectId,
          name: input.name,
          transport: "http",
          url: input.url,
          headersJson: encodeHeaders(input.headersJson),
          enabled: input.enabled,
        },
      });
      return shapeRow(row);
    } catch (err) {
      // Prisma unique constraint (projectId, name) — surface as a friendly
      // 409 instead of leaking the raw P2002. Matching on the error class +
      // code is robust to localized message strings.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
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
    const row = await ctx.db.mcpServerConfig.update({
      where: { id: existing.id },
      data: {
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.headersJson !== undefined
          ? { headersJson: encodeHeaders(input.headersJson) }
          : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      },
    });
    return shapeRow(row);
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

  oauth: mcpOauthRouter,
});
