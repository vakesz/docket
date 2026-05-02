/**
 * MCP server configuration API.
 *
 * Per-project HTTP-only MCP servers. Stored in `mcpServerConfigs`; consumed
 * by `src/agent/mcp/tools.ts` when the agent loop builds the tool
 * registry.
 */

import "server-only";
import { TRPCError } from "@trpc/server";
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { mcpServerConfigs } from "@/db/schema";
import type { McpServerConfig } from "@/db/schema/types";
import { decodeHeaders, encodeHeaders } from "@/server/mcp/headers-codec";
import { mcpOauthRouter } from "@/server/mcp/oauth/router";
import {
  assertFound,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  projectSlugSchema,
  router,
} from "@/server/trpc";

const ServerRef = projectSlugSchema.extend({
  serverId: z.string().min(1),
});

const HeadersJson = z.record(z.string(), z.string()).default({});

const CreateInput = projectSlugSchema.extend({
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
}).refine(
  (input) =>
    input.url !== undefined || input.headersJson !== undefined || input.enabled !== undefined,
  { message: "at least one field (url, headersJson, enabled) must be supplied" },
);

function shapeRow(row: McpServerConfig) {
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

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "23505"
  );
}

export const mcpRouter = router({
  list: projectScopedProcedure.input(projectSlugSchema).query(async ({ ctx }) => {
    const rows = await ctx.db.query.mcpServerConfigs.findMany({
      where: eq(mcpServerConfigs.projectId, ctx.projectId),
      orderBy: [asc(mcpServerConfigs.name)],
    });
    return rows.map(shapeRow);
  }),

  get: projectScopedProcedure.input(ServerRef).query(async ({ ctx, input }) => {
    const row = assertFound(
      await ctx.db.query.mcpServerConfigs.findFirst({
        where: and(
          eq(mcpServerConfigs.id, input.serverId),
          eq(mcpServerConfigs.projectId, ctx.projectId),
        ),
      }),
      "MCP server not found",
    );
    return shapeRow(row);
  }),

  create: projectScopedMutationProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    try {
      const [row] = await ctx.db
        .insert(mcpServerConfigs)
        .values({
          projectId: ctx.projectId,
          name: input.name,
          transport: "http",
          url: input.url,
          headersJson: encodeHeaders(input.headersJson),
          enabled: input.enabled,
        })
        .returning();
      if (!row) throw new Error("MCP server create returned no row");
      return shapeRow(row);
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `An MCP server named '${input.name}' already exists in this project.`,
        });
      }
      throw err;
    }
  }),

  update: projectScopedMutationProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db
      .update(mcpServerConfigs)
      .set({
        ...(input.url !== undefined ? { url: input.url } : {}),
        ...(input.headersJson !== undefined
          ? { headersJson: encodeHeaders(input.headersJson) }
          : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      })
      .where(
        and(eq(mcpServerConfigs.id, input.serverId), eq(mcpServerConfigs.projectId, ctx.projectId)),
      )
      .returning();
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
    }
    return shapeRow(row);
  }),

  delete: projectScopedMutationProcedure.input(ServerRef).mutation(async ({ ctx, input }) => {
    const deleted = await ctx.db
      .delete(mcpServerConfigs)
      .where(
        and(eq(mcpServerConfigs.id, input.serverId), eq(mcpServerConfigs.projectId, ctx.projectId)),
      )
      .returning({ id: mcpServerConfigs.id });
    if (deleted.length === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: "MCP server not found" });
    }
    return { id: input.serverId };
  }),

  oauth: mcpOauthRouter,
});
