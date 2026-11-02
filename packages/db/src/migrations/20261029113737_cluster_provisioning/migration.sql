ALTER TABLE "clusters" ADD COLUMN "sidecar_certificate" text;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "provisioning" jsonb;--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "provisioning_secrets" text;