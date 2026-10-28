CREATE TABLE "cluster_provision_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"provision_id" uuid NOT NULL,
	"text" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cluster_provisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"user" text DEFAULT 'root' NOT NULL,
	"public_key" text NOT NULL,
	"encrypted_private_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"init_state" text DEFAULT 'none' NOT NULL,
	"error" text,
	"requested_at" timestamp with time zone,
	"cluster_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clusters" ADD COLUMN "sidecar_certificate" text;--> statement-breakpoint
ALTER TABLE "cluster_provision_logs" ADD CONSTRAINT "cluster_provision_logs_provision_id_cluster_provisions_id_fk" FOREIGN KEY ("provision_id") REFERENCES "public"."cluster_provisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_provisions" ADD CONSTRAINT "cluster_provisions_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cluster_provisions" ADD CONSTRAINT "cluster_provisions_cluster_id_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cluster_provision_logs_provision_idx" ON "cluster_provision_logs" USING btree ("provision_id","id");--> statement-breakpoint
CREATE INDEX "cluster_provisions_organization_idx" ON "cluster_provisions" USING btree ("organization_id");