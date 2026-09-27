ALTER TABLE "cluster_monitoring" DROP COLUMN "machine_id";--> statement-breakpoint
-- Machine IDs are deprecated in favor of names. Existing values stay valid because Uncloud
-- resolves placement by name or ID; the key is renamed so the app reads a single field.
UPDATE "clusters"
SET "initialization_configuration" = ("initialization_configuration" - 'machineId')
    || jsonb_build_object('machine', "initialization_configuration"->'machineId')
WHERE "initialization_configuration" ? 'machineId';
