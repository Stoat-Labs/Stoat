CREATE TABLE "resource_groups" (
	"id" uuid PRIMARY KEY,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"icon" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "resources" ADD COLUMN "group_id" uuid;--> statement-breakpoint
CREATE INDEX "resource_groups_project_idx" ON "resource_groups" ("project_id");--> statement-breakpoint
CREATE INDEX "resources_group_idx" ON "resources" ("group_id");--> statement-breakpoint
ALTER TABLE "resource_groups" ADD CONSTRAINT "resource_groups_project_id_projects_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_group_id_resource_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "resource_groups"("id") ON DELETE SET NULL;