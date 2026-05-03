DROP INDEX "conversations_project_archived_idx";--> statement-breakpoint
DROP INDEX "conversations_user_archived_idx";--> statement-breakpoint
DROP INDEX "conversations_item_archived_idx";--> statement-breakpoint
CREATE INDEX "conversations_project_idx" ON "conversations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "conversations_user_idx" ON "conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "conversations_item_idx" ON "conversations" USING btree ("item_id");--> statement-breakpoint
ALTER TABLE "conversations" DROP COLUMN "archived_at";