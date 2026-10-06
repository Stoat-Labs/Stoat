-- Pre-release: old single-bucket connections have no provider and are dropped.
DELETE FROM "s3_connections";--> statement-breakpoint
CREATE TABLE "s3_buckets" (
	"resource_id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"error" text,
	"key_id" text,
	"encrypted_credentials" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "s3_buckets_connection_name_uidx" UNIQUE("connection_id","name"),
	CONSTRAINT "s3_buckets_status_check" CHECK ("s3_buckets"."status" in ('provisioning', 'ready', 'failed', 'deleting'))
);
--> statement-breakpoint
ALTER TABLE "s3_connections" ADD COLUMN "provider" text NOT NULL;--> statement-breakpoint
ALTER TABLE "s3_connections" ADD COLUMN "region" text DEFAULT 'us-east-1' NOT NULL;--> statement-breakpoint
ALTER TABLE "s3_connections" ADD COLUMN "provider_account_id" text;--> statement-breakpoint
ALTER TABLE "s3_connections" ADD COLUMN "encrypted_api_token" text;--> statement-breakpoint
ALTER TABLE "s3_buckets" ADD CONSTRAINT "s3_buckets_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "s3_buckets" ADD CONSTRAINT "s3_buckets_connection_id_s3_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."s3_connections"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "s3_connections" DROP COLUMN "bucket";--> statement-breakpoint
ALTER TABLE "s3_connections" ADD CONSTRAINT "s3_connections_provider_check" CHECK ("s3_connections"."provider" in ('generic', 'rustfs', 'r2'));--> statement-breakpoint
ALTER TABLE "s3_connections" ADD CONSTRAINT "s3_connections_provider_account_check" CHECK (("s3_connections"."provider" = 'r2') = (
                "s3_connections"."provider_account_id" is not null and "s3_connections"."encrypted_api_token" is not null
            ));