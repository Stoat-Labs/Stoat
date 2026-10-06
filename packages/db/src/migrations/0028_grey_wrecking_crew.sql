CREATE TABLE "s3_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"endpoint" text NOT NULL,
	"bucket" text NOT NULL,
	"force_path_style" boolean DEFAULT false NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"last_tested_at" timestamp with time zone,
	"last_test_status" text,
	"last_test_error" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "s3_connections_organization_name_uidx" UNIQUE("organization_id","name"),
	CONSTRAINT "s3_connections_test_status_check" CHECK ("s3_connections"."last_test_status" in ('success', 'failure') or "s3_connections"."last_test_status" is null)
);
--> statement-breakpoint
ALTER TABLE "s3_connections" ADD CONSTRAINT "s3_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "s3_connections_organization_idx" ON "s3_connections" USING btree ("organization_id");