-- Rename to Clowder. Secrets are re-encrypted by the pre-deploy script (apps/web/scripts/rebrand.ts).

-- The built-in variables and the Compose extension were renamed.
CREATE OR REPLACE FUNCTION pg_temp.clowder(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT regexp_replace(
        regexp_replace(
            value,
            '\mSTOAT_(DOMAIN|PREFIX|PROJECT_ID|PROJECT_NAME|RESOURCE_ID|RESOURCE_NAME)\M',
            'CLOWDER_\1',
            'g'
        ),
        '\mx-stoat\M',
        'x-clowder',
        'g'
    )
$$;
--> statement-breakpoint
UPDATE "resources" SET
    "spec" = pg_temp.clowder("spec"),
    "draft_spec" = pg_temp.clowder("draft_spec"),
    "settings" = pg_temp.clowder("settings"::text)::jsonb,
    "draft_config_files" = pg_temp.clowder("draft_config_files"::text)::jsonb;
--> statement-breakpoint
-- Past deployments too, so a redeploy of one resolves like it did.
UPDATE "deployments" SET "spec" = pg_temp.clowder("spec") WHERE "spec" IS NOT NULL;
--> statement-breakpoint
UPDATE "resource_deployment_inputs" SET
    "env" = pg_temp.clowder("env"),
    "config_files" = pg_temp.clowder("config_files"::text)::jsonb;
--> statement-breakpoint
-- Monitoring now deploys as clowder-monitoring-*. Clusters that relied on the default volumes
-- keep them, so the new services reuse the metrics and logs collected so far.
UPDATE "clusters" SET "initialization_configuration" =
    jsonb_build_object(
        'greptimeStorage', '{"type": "volume", "source": "stoat-monitoring-greptime"}'::jsonb,
        'alloyStorage', '{"type": "volume", "source": "stoat-monitoring-alloy"}'::jsonb
    ) || "initialization_configuration"
WHERE "initialization_configuration" IS NOT NULL
    AND "id" IN (SELECT "cluster_id" FROM "cluster_monitoring");
--> statement-breakpoint
UPDATE "clusters"
SET "greptime_url" = replace("greptime_url", 'stoat-monitoring-greptimedb', 'clowder-monitoring-greptimedb')
WHERE "greptime_url" LIKE '%stoat-monitoring-greptimedb%';
--> statement-breakpoint
UPDATE "effect_mq_schedules" SET "group_name" = 'clowder' WHERE "group_name" = 'stoat';
