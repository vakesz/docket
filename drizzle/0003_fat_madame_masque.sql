ALTER TABLE "sessions" DROP CONSTRAINT "sessions_sessionToken_unique";--> statement-breakpoint
DROP INDEX "command_usage_user_project_command_idx";--> statement-breakpoint
ALTER TABLE "sessions" ADD PRIMARY KEY ("session_token");--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "id";--> statement-breakpoint
ALTER TABLE "command_usage" ADD CONSTRAINT "command_usage_user_project_command_unique" UNIQUE NULLS NOT DISTINCT("user_id","project_id","command_id");