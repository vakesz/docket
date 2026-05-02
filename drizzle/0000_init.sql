CREATE TABLE "audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid,
	"action" text NOT NULL,
	"proposal_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "sessions_sessionToken_unique" UNIQUE("session_token")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"email" text NOT NULL,
	"email_verified" timestamp with time zone,
	"image" text,
	"default_project_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token"),
	CONSTRAINT "verification_tokens_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "avatars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_kind" text NOT NULL,
	"identifier" text NOT NULL,
	"bytes" "bytea",
	"content_type" text,
	"etag" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"failed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "command_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"command_id" text NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"usage_count" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"item_id" uuid,
	"llm_provider_id_override" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"guardrail_tokens_in" integer DEFAULT 0 NOT NULL,
	"guardrail_tokens_out" integer DEFAULT 0 NOT NULL,
	"guardrail_cost_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls_json" jsonb,
	"tool_call_id" text,
	"tool_name" text,
	"compacted" boolean DEFAULT false NOT NULL,
	"pending" boolean DEFAULT false NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"guardrail_reason" text,
	"tokens_in" integer DEFAULT 0 NOT NULL,
	"tokens_out" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" IN ('system', 'user', 'assistant', 'tool'))
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"provider_comment_id" text NOT NULL,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"provider_updated_at" timestamp with time zone,
	"edited" boolean DEFAULT false NOT NULL,
	"reactions" jsonb
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"provider_item_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"state" text NOT NULL,
	"assignees" text[] DEFAULT '{}' NOT NULL,
	"reviewers" text[] DEFAULT '{}' NOT NULL,
	"linked_item_ids" text[] DEFAULT '{}' NOT NULL,
	"author" text,
	"parent_id" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"provider_raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"url" text,
	"repository_url" text,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"synced_at" timestamp with time zone NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"reactions" jsonb,
	"milestone" text,
	"iteration" text,
	"area" text,
	"ci_summary" jsonb
);
--> statement-breakpoint
CREATE TABLE "llm_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"role" text DEFAULT 'chat' NOT NULL,
	"label" text NOT NULL,
	"api_key" text NOT NULL,
	"model" text DEFAULT '' NOT NULL,
	"base_url" text DEFAULT '' NOT NULL,
	"input_price_cents_per_mtok" numeric(12, 4),
	"output_price_cents_per_mtok" numeric(12, 4),
	"is_default" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_providers_role_check" CHECK ("llm_providers"."role" IN ('chat', 'guardrail'))
);
--> statement-breakpoint
CREATE TABLE "mcp_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce" text NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mcp_server_id" text NOT NULL,
	"code_verifier" text NOT NULL,
	"issuer" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text,
	"scopes" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_oauth_states_nonce_unique" UNIQUE("nonce")
);
--> statement-breakpoint
CREATE TABLE "mcp_server_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"transport" text DEFAULT 'http' NOT NULL,
	"url" text NOT NULL,
	"headers_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"oauth_issuer" text,
	"oauth_client_id" text,
	"oauth_client_secret" text,
	"oauth_scopes" text,
	"oauth_refresh_token" text,
	"oauth_access_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"source" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_entries_source_check" CHECK ("memory_entries"."source" IN ('user', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "oauth_provider_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"scopes" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_memberships_role_check" CHECK ("project_memberships"."role" IN ('viewer', 'member', 'approver'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"provider_kind" text NOT NULL,
	"provider_scope" jsonb NOT NULL,
	"default_llm_provider_id" uuid,
	"default_guardrail_provider_id" uuid,
	"default_temperature" double precision,
	"owner_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"origin" text DEFAULT 'agent' NOT NULL,
	"provider_item_id" text,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"error_message" text,
	"advisory" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proposals_status_check" CHECK ("proposals"."status" IN ('pending', 'confirmed', 'rejected', 'expired')),
	CONSTRAINT "proposals_origin_check" CHECK ("proposals"."origin" IN ('ui', 'agent'))
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"scope" text NOT NULL,
	"user_id" uuid,
	"project_id" uuid,
	"encrypted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_scope_check" CHECK ("settings"."scope" IN ('global', 'user', 'project'))
);
--> statement-breakpoint
CREATE TABLE "source_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" text DEFAULT '' NOT NULL,
	"uri" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dismissed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sync_cursors" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"watermark" timestamp with time zone,
	"last_full_sync_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"state_bucket" text DEFAULT 'open' NOT NULL,
	"assignees" text[] DEFAULT '{}' NOT NULL,
	"facets" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watchlist_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"provider_item_id" text NOT NULL,
	"pinned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_fetch_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid,
	"url" text NOT NULL,
	"status" text NOT NULL,
	"content_type" text,
	"bytes" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"cleaned" boolean,
	"cleaned_bytes" integer,
	"clean_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audits" ADD CONSTRAINT "audits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_usage" ADD CONSTRAINT "command_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "command_usage" ADD CONSTRAINT "command_usage_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_llm_provider_id_override_llm_providers_id_fk" FOREIGN KEY ("llm_provider_id_override") REFERENCES "public"."llm_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comments" ADD CONSTRAINT "comments_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_server_configs" ADD CONSTRAINT "mcp_server_configs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_entries" ADD CONSTRAINT "memory_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_memberships" ADD CONSTRAINT "project_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_llm_provider_id_llm_providers_id_fk" FOREIGN KEY ("default_llm_provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_guardrail_provider_id_llm_providers_id_fk" FOREIGN KEY ("default_guardrail_provider_id") REFERENCES "public"."llm_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "source_docs" ADD CONSTRAINT "source_docs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suggestions" ADD CONSTRAINT "suggestions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_cursors" ADD CONSTRAINT "sync_cursors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_entries" ADD CONSTRAINT "watchlist_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watchlist_entries" ADD CONSTRAINT "watchlist_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_fetch_events" ADD CONSTRAINT "web_fetch_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_fetch_events" ADD CONSTRAINT "web_fetch_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audits_project_created_at_idx" ON "audits" USING btree ("project_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "audits_project_action_idx" ON "audits" USING btree ("project_id","action");--> statement-breakpoint
CREATE INDEX "audits_created_at_idx" ON "audits" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_idx" ON "accounts" USING btree ("provider","provider_account_id");--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "users_default_project_id_idx" ON "users" USING btree ("default_project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "avatars_provider_identifier_idx" ON "avatars" USING btree ("provider_kind","identifier");--> statement-breakpoint
CREATE INDEX "avatars_fetched_at_idx" ON "avatars" USING btree ("fetched_at");--> statement-breakpoint
CREATE UNIQUE INDEX "command_usage_user_project_command_idx" ON "command_usage" USING btree ("user_id","project_id","command_id");--> statement-breakpoint
CREATE INDEX "command_usage_user_last_used_at_idx" ON "command_usage" USING btree ("user_id","last_used_at" DESC);--> statement-breakpoint
CREATE INDEX "conversations_project_archived_idx" ON "conversations" USING btree ("project_id","archived_at");--> statement-breakpoint
CREATE INDEX "conversations_user_archived_idx" ON "conversations" USING btree ("user_id","archived_at");--> statement-breakpoint
CREATE INDEX "conversations_item_archived_idx" ON "conversations" USING btree ("item_id","archived_at");--> statement-breakpoint
CREATE INDEX "conversations_started_at_idx" ON "conversations" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "conversations_llm_override_idx" ON "conversations" USING btree ("llm_provider_id_override");--> statement-breakpoint
CREATE INDEX "messages_conversation_created_at_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_conversation_compacted_created_at_idx" ON "messages" USING btree ("conversation_id","compacted","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "comments_item_provider_comment_idx" ON "comments" USING btree ("item_id","provider_comment_id");--> statement-breakpoint
CREATE INDEX "comments_item_created_at_idx" ON "comments" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "items_project_provider_item_idx" ON "items" USING btree ("project_id","provider_item_id");--> statement-breakpoint
CREATE INDEX "items_project_kind_archived_idx" ON "items" USING btree ("project_id","kind","archived");--> statement-breakpoint
CREATE INDEX "items_project_updated_at_idx" ON "items" USING btree ("project_id","updated_at");--> statement-breakpoint
CREATE INDEX "items_project_parent_id_idx" ON "items" USING btree ("project_id","parent_id");--> statement-breakpoint
CREATE INDEX "llm_providers_kind_idx" ON "llm_providers" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "llm_providers_role_is_default_idx" ON "llm_providers" USING btree ("role","is_default");--> statement-breakpoint
CREATE INDEX "mcp_oauth_states_expires_at_idx" ON "mcp_oauth_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_server_configs_project_name_idx" ON "mcp_server_configs" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "mcp_server_configs_project_enabled_idx" ON "mcp_server_configs" USING btree ("project_id","enabled");--> statement-breakpoint
CREATE INDEX "memory_entries_project_updated_at_idx" ON "memory_entries" USING btree ("project_id","updated_at" DESC);--> statement-breakpoint
CREATE INDEX "oauth_provider_configs_kind_idx" ON "oauth_provider_configs" USING btree ("kind");--> statement-breakpoint
CREATE UNIQUE INDEX "project_memberships_project_user_idx" ON "project_memberships" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "project_memberships_user_idx" ON "project_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_owner_archived_idx" ON "projects" USING btree ("owner_user_id","archived_at");--> statement-breakpoint
CREATE INDEX "projects_provider_kind_idx" ON "projects" USING btree ("provider_kind");--> statement-breakpoint
CREATE INDEX "projects_default_llm_idx" ON "projects" USING btree ("default_llm_provider_id");--> statement-breakpoint
CREATE INDEX "projects_default_guardrail_idx" ON "projects" USING btree ("default_guardrail_provider_id");--> statement-breakpoint
CREATE INDEX "proposals_project_status_created_at_idx" ON "proposals" USING btree ("project_id","status","created_at" DESC);--> statement-breakpoint
CREATE INDEX "proposals_user_status_idx" ON "proposals" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "settings_scope_key_idx" ON "settings" USING btree ("scope","key");--> statement-breakpoint
CREATE UNIQUE INDEX "settings_key_global_idx" ON "settings" USING btree ("key") WHERE "settings"."user_id" IS NULL AND "settings"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "settings_key_user_idx" ON "settings" USING btree ("key","user_id") WHERE "settings"."user_id" IS NOT NULL AND "settings"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "settings_key_project_idx" ON "settings" USING btree ("key","project_id") WHERE "settings"."user_id" IS NULL AND "settings"."project_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "source_docs_project_updated_at_idx" ON "source_docs" USING btree ("project_id","updated_at" DESC);--> statement-breakpoint
CREATE INDEX "source_docs_project_kind_idx" ON "source_docs" USING btree ("project_id","kind");--> statement-breakpoint
CREATE INDEX "suggestions_project_kind_dismissed_idx" ON "suggestions" USING btree ("project_id","kind","dismissed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_views_user_project_name_idx" ON "saved_views" USING btree ("user_id","project_id","name");--> statement-breakpoint
CREATE INDEX "saved_views_user_project_default_idx" ON "saved_views" USING btree ("user_id","project_id","is_default");--> statement-breakpoint
CREATE UNIQUE INDEX "watchlist_user_project_provider_item_idx" ON "watchlist_entries" USING btree ("user_id","project_id","provider_item_id");--> statement-breakpoint
CREATE INDEX "watchlist_user_pinned_at_idx" ON "watchlist_entries" USING btree ("user_id","pinned_at" DESC);--> statement-breakpoint
CREATE INDEX "web_fetch_events_project_created_at_idx" ON "web_fetch_events" USING btree ("project_id","created_at" DESC);--> statement-breakpoint
CREATE INDEX "web_fetch_events_project_status_idx" ON "web_fetch_events" USING btree ("project_id","status");