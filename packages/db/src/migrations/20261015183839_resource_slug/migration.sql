ALTER TABLE "resources" ADD COLUMN "slug" text;--> statement-breakpoint
-- The prefix existing resources were deployed under, so nothing running is renamed.
UPDATE "resources" SET "slug" = left("project_id"::text, 8) || '-' || left("id"::text, 8);--> statement-breakpoint
ALTER TABLE "resources" ALTER COLUMN "slug" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "resources_slug_idx" ON "resources" USING btree ("slug");
