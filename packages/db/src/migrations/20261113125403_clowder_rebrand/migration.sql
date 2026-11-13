-- Rename the built-in variables and the Compose extension to Clowder. Only actual uses change:
-- literal data (image paths, config files, Compose `environment` keys) stays as it was.

-- `$STOAT_X` / `${STOAT_X...` uses, not escaped ones (`$$` is a literal `$`).
CREATE OR REPLACE FUNCTION pg_temp.clowder_uses(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT regexp_replace(
        value,
        '(?<!\$)((?:\$\$)*)\$(\{?)STOAT_(DOMAIN|PREFIX|PROJECT_ID|PROJECT_NAME|RESOURCE_ID|RESOURCE_NAME)(?![A-Za-z0-9_])',
        '\1$\2CLOWDER_\3',
        'g'
    )
$$;
--> statement-breakpoint
-- Compose YAML: variable uses and `x-stoat` mapping keys.
CREATE OR REPLACE FUNCTION pg_temp.clowder_compose(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT regexp_replace(
        pg_temp.clowder_uses(value),
        '(^|[\s{,])(["'']?)x-stoat\2(?=[ \t]*:)',
        '\1\2x-clowder\2',
        'g'
    )
$$;
--> statement-breakpoint
-- Variables (.env text): uses, `{{ <id>.STOAT_X }}` references and `STOAT_X=` assignment keys.
CREATE OR REPLACE FUNCTION pg_temp.clowder_env(value text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
    SELECT regexp_replace(
        regexp_replace(
            pg_temp.clowder_uses(value),
            '(\{\{\s*[^\s{}.]+\.)STOAT_(DOMAIN|PREFIX|PROJECT_ID|PROJECT_NAME|RESOURCE_ID|RESOURCE_NAME)(?=\s*\}\})',
            '\1CLOWDER_\2',
            'g'
        ),
        '^([ \t]*(?:export[ \t]+)?)STOAT_(DOMAIN|PREFIX|PROJECT_ID|PROJECT_NAME|RESOURCE_ID|RESOURCE_NAME)(?=[ \t]*=)',
        '\1CLOWDER_\2',
        'gn'
    )
$$;
--> statement-breakpoint
UPDATE "resources" SET
    "spec" = pg_temp.clowder_compose("spec"),
    "draft_spec" = pg_temp.clowder_compose("draft_spec");
--> statement-breakpoint
UPDATE "resources"
SET "settings" = jsonb_set("settings", '{env}', to_jsonb(pg_temp.clowder_env("settings"->>'env')))
WHERE jsonb_typeof("settings"->'env') = 'string';
--> statement-breakpoint
-- Past deployments too, so a redeploy of one resolves like it did.
UPDATE "deployments" SET "spec" = pg_temp.clowder_compose("spec") WHERE "spec" IS NOT NULL;
--> statement-breakpoint
UPDATE "resource_deployment_inputs" SET "env" = pg_temp.clowder_env("env");
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
