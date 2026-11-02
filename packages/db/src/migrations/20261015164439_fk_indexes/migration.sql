CREATE INDEX "clusters_organization_idx" ON "clusters" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "deployments_resource_idx" ON "deployments" USING btree ("resource_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "projects_cluster_idx" ON "projects" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "resources_project_idx" ON "resources" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "resources_git_connection_idx" ON "resources" USING btree ("git_connection_id");