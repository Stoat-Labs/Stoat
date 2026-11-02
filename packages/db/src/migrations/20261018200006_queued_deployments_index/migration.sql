DROP TABLE "resource_env_vars" CASCADE;--> statement-breakpoint
CREATE INDEX "deployments_queued_idx" ON "deployments" USING btree ("name") WHERE "deployments"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "project_favorites_project_idx" ON "project_favorites" USING btree ("project_id");