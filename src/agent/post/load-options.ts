/**
 * Resolve the project-scoped code-snippet cap options into the shape
 * `capCodeSnippets` expects. Three Setting reads, no caching — caps
 * change rarely, and a cached layer would have to know about
 * project switches and read-only mode, neither of which is worth the
 * complexity for three rows.
 */

import "server-only";
import type { CodeSnippetCapOptions } from "@/agent/post/code-snippet-cap";
import type { db as Db } from "@/server/db";
import { loadProjectSetting } from "@/server/settings/effective";

export async function loadCodeSnippetCapOptions(
  db: typeof Db,
  projectId: string,
): Promise<CodeSnippetCapOptions> {
  const [enabled, maxLines, maxSnippetsPerReply] = await Promise.all([
    loadProjectSetting(db, projectId, "recommendations.code-examples.enabled"),
    loadProjectSetting(db, projectId, "recommendations.code-examples.max-lines"),
    loadProjectSetting(db, projectId, "recommendations.code-examples.max-snippets-per-reply"),
  ]);
  return { enabled, maxLines, maxSnippetsPerReply };
}
