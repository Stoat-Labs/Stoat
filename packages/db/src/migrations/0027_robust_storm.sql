CREATE TABLE "instance_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"signups_enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "instance_settings_singleton" CHECK ("instance_settings"."id" = 1)
);
