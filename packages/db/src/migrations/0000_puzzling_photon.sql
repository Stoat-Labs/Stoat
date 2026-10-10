CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer,
	"rate_limit_max" integer,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"active_organization_id" text,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cluster_monitoring" (
	"cluster_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"resource_id" uuid NOT NULL,
	"encrypted_password" text NOT NULL,
	CONSTRAINT "cluster_monitoring_project_id_unique" UNIQUE("project_id"),
	CONSTRAINT "cluster_monitoring_resource_id_unique" UNIQUE("resource_id")
);
--> statement-breakpoint
CREATE TABLE "clusters" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"sidecar_url" text NOT NULL,
	"sidecar_token" text NOT NULL,
	"greptime_url" text,
	"organization_id" text NOT NULL,
	"initialised_at" timestamp with time zone,
	"initialization_requested_at" timestamp with time zone,
	"initialization_status" text DEFAULT 'uninitialized' NOT NULL,
	"initialization_error" text,
	"initialization_configuration" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"stream" text DEFAULT 'build' NOT NULL,
	"text" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"cluster_id" uuid NOT NULL,
	"name" text NOT NULL,
	"resource_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"job_id" text NOT NULL,
	"spec" text,
	"configuration" jsonb,
	"error" text,
	"progress" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "deployments_job_id_unique" UNIQUE("job_id")
);
--> statement-breakpoint
CREATE TABLE "git_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"server_url" text NOT NULL,
	"auth_type" text DEFAULT 'token' NOT NULL,
	"account" jsonb,
	"repositories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"encrypted_credentials" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "git_oauth_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"server_url" text NOT NULL,
	"client_id" text NOT NULL,
	"encrypted_client_secret" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"signups_enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "instance_settings_singleton" CHECK ("instance_settings"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cluster_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"is_internal" boolean DEFAULT false,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_deployment_inputs" (
	"deployment_id" uuid PRIMARY KEY NOT NULL,
	"prefix" text NOT NULL,
	"env" text DEFAULT '' NOT NULL,
	"recreate" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_env_vars" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resource_id" uuid NOT NULL,
	"service" text,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"secret" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "resource_env_service_key_uidx" UNIQUE NULLS NOT DISTINCT("resource_id","service","key")
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text,
	"type" text DEFAULT 'compose',
	"spec" text,
	"draft_spec" text,
	"settings" jsonb,
	"git_connection_id" uuid,
	"git_source" jsonb,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "s3_buckets" (
	"resource_id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"error" text,
	"key_id" text,
	"encrypted_credentials" text,
	"metadata" jsonb,
	"quota" bigint,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "s3_buckets_connection_name_uidx" UNIQUE("connection_id","name"),
	CONSTRAINT "s3_buckets_status_check" CHECK ("s3_buckets"."status" in ('provisioning', 'ready', 'failed', 'deleting'))
);
--> statement-breakpoint
CREATE TABLE "s3_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"region" text DEFAULT 'us-east-1' NOT NULL,
	"force_path_style" boolean DEFAULT false NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"provider_account_id" text,
	"encrypted_api_token" text,
	"last_tested_at" timestamp with time zone,
	"last_test_status" text,
	"last_test_error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "s3_connections_organization_name_uidx" UNIQUE("organization_id","name"),
	CONSTRAINT "s3_connections_provider_check" CHECK ("s3_connections"."provider" in ('generic', 'rustfs', 'r2')),
	CONSTRAINT "s3_connections_provider_account_check" CHECK (("s3_connections"."provider" = 'r2') = (
                "s3_connections"."provider_account_id" is not null and "s3_connections"."encrypted_api_token" is not null
            )),
	CONSTRAINT "s3_connections_test_status_check" CHECK ("s3_connections"."last_test_status" in ('success', 'failure') or "s3_connections"."last_test_status" is null)
);
--> statement-breakpoint
CREATE TABLE "effect_mq_job_attempts" (
	"job_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"outcome" text NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone NOT NULL,
	"exit" jsonb,
	CONSTRAINT "effect_mq_job_attempts_job_id_attempt_pk" PRIMARY KEY("job_id","attempt")
);
--> statement-breakpoint
CREATE TABLE "effect_mq_dedupe" (
	"name" text NOT NULL,
	"key" text NOT NULL,
	"job_id" text NOT NULL,
	"window_expires_at" timestamp with time zone,
	CONSTRAINT "effect_mq_dedupe_name_key_pk" PRIMARY KEY("name","key")
);
--> statement-breakpoint
CREATE TABLE "effect_mq_flow_children" (
	"flow_id" text NOT NULL,
	"child_key" text NOT NULL,
	"name" text NOT NULL,
	"store_key" text NOT NULL,
	"spec" jsonb NOT NULL,
	"status" text NOT NULL,
	"exit" jsonb,
	"failed_reason" text,
	"cascaded" boolean NOT NULL,
	"pending_since" timestamp with time zone NOT NULL,
	CONSTRAINT "effect_mq_flow_children_flow_id_child_key_pk" PRIMARY KEY("flow_id","child_key")
);
--> statement-breakpoint
CREATE TABLE "effect_mq_flow_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"flow_name" text NOT NULL,
	"parent_store_key" text NOT NULL,
	"report" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "effect_mq_queue_control" (
	"queue" text PRIMARY KEY NOT NULL,
	"paused" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "effect_mq_schedules" (
	"key" text PRIMARY KEY NOT NULL,
	"job_name" text NOT NULL,
	"queue" text NOT NULL,
	"cron" text,
	"tz" text,
	"every_ms" bigint,
	"payload" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempts_max" integer NOT NULL,
	"backoff" jsonb,
	"keep" jsonb,
	"timeout_ms" bigint,
	"group_name" text,
	"next_run_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "effect_mq_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"queue" text NOT NULL,
	"state" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"seq" bigint GENERATED BY DEFAULT AS IDENTITY (sequence name "effect_mq_jobs_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"payload" jsonb,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts_max" integer NOT NULL,
	"attempts_made" integer DEFAULT 0 NOT NULL,
	"stalled_count" integer DEFAULT 0 NOT NULL,
	"backoff" jsonb,
	"keep" jsonb,
	"timeout_ms" bigint,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"dedupe_key" text,
	"trace" jsonb,
	"parent" jsonb,
	"flow_fail_fast" boolean,
	"flow_pending" integer,
	"flow_completed" integer,
	"flow_failed" integer,
	"flow_cancelled" integer,
	"run_at" timestamp with time zone NOT NULL,
	"enqueued_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"exit" jsonb,
	"failed_reason" text,
	"lock_token" text,
	"lock_expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apikey" ADD CONSTRAINT "apikey_reference_id_organization_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_monitoring" ADD CONSTRAINT "cluster_monitoring_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_monitoring" ADD CONSTRAINT "cluster_monitoring_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_monitoring" ADD CONSTRAINT "cluster_monitoring_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clusters" ADD CONSTRAINT "clusters_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_logs" ADD CONSTRAINT "deployment_logs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_connections" ADD CONSTRAINT "git_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "git_oauth_providers" ADD CONSTRAINT "git_oauth_providers_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_deployment_inputs" ADD CONSTRAINT "resource_deployment_inputs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_env_vars" ADD CONSTRAINT "resource_env_vars_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_git_connection_id_git_connections_id_fk" FOREIGN KEY ("git_connection_id") REFERENCES "public"."git_connections"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s3_buckets" ADD CONSTRAINT "s3_buckets_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s3_buckets" ADD CONSTRAINT "s3_buckets_connection_id_s3_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."s3_connections"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "s3_connections" ADD CONSTRAINT "s3_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "effect_mq_job_attempts" ADD CONSTRAINT "effect_mq_job_attempts_job_id_effect_mq_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."effect_mq_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_providerId_accountId_uidx" ON "account" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "apikey_configId_idx" ON "apikey" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "apikey_referenceId_idx" ON "apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" USING btree ("key");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "deployment_logs_deployment_idx" ON "deployment_logs" USING btree ("deployment_id","id");--> statement-breakpoint
CREATE INDEX "deployments_cluster_idx" ON "deployments" USING btree ("cluster_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "git_connections_organization_idx" ON "git_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "git_oauth_providers_organization_idx" ON "git_oauth_providers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "resource_env_resource_idx" ON "resource_env_vars" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "s3_connections_organization_idx" ON "s3_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "effect_mq_flow_children_pending_idx" ON "effect_mq_flow_children" USING btree ("pending_since") WHERE "effect_mq_flow_children"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "effect_mq_flow_children_cascade_idx" ON "effect_mq_flow_children" USING btree ("flow_id") WHERE "effect_mq_flow_children"."status" = 'cancelled' AND NOT "effect_mq_flow_children"."cascaded";--> statement-breakpoint
CREATE INDEX "effect_mq_schedules_due_idx" ON "effect_mq_schedules" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "effect_mq_jobs_ready_idx" ON "effect_mq_jobs" USING btree ("queue","priority" DESC NULLS LAST,"seq") WHERE "effect_mq_jobs"."state" = 'waiting';--> statement-breakpoint
CREATE INDEX "effect_mq_jobs_delayed_idx" ON "effect_mq_jobs" USING btree ("queue","run_at") WHERE "effect_mq_jobs"."state" = 'delayed';--> statement-breakpoint
CREATE INDEX "effect_mq_jobs_active_idx" ON "effect_mq_jobs" USING btree ("lock_expires_at") WHERE "effect_mq_jobs"."state" = 'active';--> statement-breakpoint
CREATE INDEX "effect_mq_jobs_history_idx" ON "effect_mq_jobs" USING btree ("name","state","finished_at");--> statement-breakpoint
CREATE INDEX "effect_mq_jobs_listing_idx" ON "effect_mq_jobs" USING btree ("enqueued_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "effect_mq_jobs_metadata_idx" ON "effect_mq_jobs" USING gin ("metadata" jsonb_path_ops);