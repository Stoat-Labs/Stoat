-- Development databases may already have this schema from drizzle-kit push.
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "spec" text;--> statement-breakpoint
ALTER TABLE "resource_deployment_inputs" DROP COLUMN IF EXISTS "spec";
