# Templates

Service templates live in `/templates`. Each app is a folder named with its **app id** (letters, numbers, dots, underscores, and hyphens).

```
templates/
  postgresql/
    manifest.json
    logo.svg
    versions/
      18/
        compose.yaml
        .env
```

Stoat lists every valid app under this directory on the **New resource** page (`/projects/<projectId>/create`) and in the canvas add palette. Apps with `"type": "database"` appear under **Databases**; everything else appears under **Templates**. Templates are bundled into the app at build time, so rebuild after adding or changing one.

## Layout

| Path                                                | Required | Purpose                                                                 |
| --------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `templates/<appid>/manifest.json`                   | yes      | Display name, description, and resource type                            |
| `templates/<appid>/logo.svg` or `logo.png`          | no       | Icon on the template card. See [Logo](#logo), or set `icon` in manifest |
| `templates/<appid>/versions/<version>/compose.yaml` | yes      | Compose file deployed for this version (`compose.yml` is also accepted) |
| `templates/<appid>/versions/<version>/.env`         | no       | Environment variables seeded onto the resource                          |

`<appid>` and `<version>` must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`; other folders are ignored. Versions are sorted newest-first using numeric comparison (`18` > `16`, `1.10` > `1.9`).

Apps with a missing manifest, a manifest that fails the schema below, or no version folder containing a compose file are skipped silently. Malformed JSON is not skipped: it throws when the templates load and breaks the whole list.

## `manifest.json`

```json
{
    "name": "PostgreSQL",
    "description": "Relational database for apps that need durable SQL storage.",
    "type": "database",
    "engine": "postgresql"
}
```

| Field         | Required      | Notes                                                                                                                                         |
| ------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | yes           | Shown on the template card and used as the default resource name                                                                              |
| `description` | yes           | Short summary under the name. Clamped to two lines on the template card                                                                       |
| `type`        | yes           | `compose` for an app, or `database`. `database` puts the app under **Databases** and requires `engine`                                        |
| `engine`      | with database | One of `postgresql`, `mongodb`, `mariadb`, `clickhouse`, `redis`, `dragonfly`. `postgresql` adds the connection URL panel on the service page |
| `icon`        | no            | [SVGL](https://svgl.app) slug, without `.svg` (for example `postgresql`). Used when `logo.svg` / `logo.png` is missing                        |
| `tags`        | no            | Category pills and the category filter on the template card (`storage`, `media`, …). They do not change the group                             |
| `resources`   | no            | Companion resources, see below                                                                                                                |

## Companion resources

An app that needs its own database or cache should not bundle it into one stack. Declare each companion in the manifest and put its files in a folder of that name inside the version:

```json
{ "resources": { "db": { "name": "Database", "engine": "postgresql" } } }
```

```
versions/16/
  compose.yaml   .env        # the app
  db/
    compose.yaml   .env      # the database, created as its own resource
```

Creating the template creates one canvas resource per folder, named `<resource name> <companion name>` (`Forgejo Database` here). `engine` makes the companion a `database` resource; omit it for a plain `compose` one. A version only ships the companions it needs, and a folder not named in `resources` is ignored.

Variables stay with the resource that owns them. The app's `.env` reads what it needs with `{{ db.NAME }}`, which becomes a reference to the created resource (`{{ <resourceId>.NAME }}`), so the canvas draws the edge and the secret lives only on the database:

```
DB_HOST={{ db.POSTGRES_INTERNAL_HOST }}
DB_PASSWORD={{ db.POSTGRES_PASSWORD }}
```

`NAME` is a variable in the companion's `.env` or one of its built-ins. Built-ins are named after the companion's Compose service key, so a service called `postgres` gives `{{ db.POSTGRES_INTERNAL_HOST }}`. References only work in `.env`, never in `compose.yaml`, so pass them to containers through a variable (`DB_HOST: ${DB_HOST}`). Required variables and secrets are collected across all the resources. A reference cannot point at another reference.

Resources deploy independently, so `depends_on` cannot cross them: the app may start before its database is healthy and relies on `restart: unless-stopped` to retry.

## Logo

Use the project's real SVG logo as `templates/<appid>/logo.svg`. Look on [selfh.st icons](https://selfh.st/icons) first (`https://cdn.jsdelivr.net/gh/selfhst/icons/svg/<name>.svg`), then the project's official brand assets. Never use a favicon. `logo.png` also works; `logo.svg` wins when both exist. Local logos are inlined into the build.

If there is no local file, set `"icon"` in the manifest to an [SVGL](https://svgl.app) library name. Stoat loads it from `https://api.svgl.app/svg/<icon>.svg`.

## Compose and environment

`compose.yaml` is copied onto the new resource as-is (after secret expansion). Do not use `env_file: .env` or a fixed `container_name`: Stoat stores `.env` values as the resource's Variables and substitutes them into the compose file at deploy time, so pass them to containers explicitly (`POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}`).

`.env` uses standard `NAME=value` syntax (quotes, `export`, and comments are supported). Those variables are created on the resource so they can be edited under **Environment**. Values are interpolated like Compose at deploy time, so they can build on other variables and built-ins (`FORGEJO_HOST=${FORGEJO_SERVICE_NAME}.${STOAT_DOMAIN}`); write `$$` for a literal `$`.

Leave a value empty (`ADMIN_EMAIL=`) to make it required: the deploy screen asks for it and the resource can't be created until it is set. Only a bare `KEY=` counts (`KEY=""` and `export KEY=` do not), and the value entered there must be a single line.

Stoat also provides these variables at deploy time. A variable you define with the same name overrides any of them.

| Variable                  | Value                                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `<SERVICE>_SERVICE_NAME`  | The service's deployed name, e.g. `my-db-k3f9x2-postgres`                                    |
| `<SERVICE>_INTERNAL_HOST` | Its cluster-internal hostname, e.g. `my-db-k3f9x2-postgres.internal`                         |
| `<SERVICE>_PUBLIC_DOMAIN` | The hostname from its `x-ports`, only when one is set                                        |
| `STOAT_PREFIX`            | The resource prefix, e.g. `my-db-k3f9x2`, or empty when prefixing is off                     |
| `STOAT_DOMAIN`            | The cluster's reserved domain, read on every deploy, e.g. `abc.uncld.dev`. Unset without one |
| `STOAT_PROJECT_NAME`      | The project's name                                                                           |
| `STOAT_PROJECT_ID`        | The project's id                                                                             |
| `STOAT_RESOURCE_NAME`     | The resource's name                                                                          |
| `STOAT_RESOURCE_ID`       | The resource's id                                                                            |

`<SERVICE>` is the Compose service key uppercased with non-alphanumerics turned into `_` (`postgres-metrics` → `POSTGRES_METRICS`). The prefix is the resource's slug plus six random characters, fixed at creation; template resources are always prefixed. Bare service names in `environment` values (`http://server`) and `x-caddy` upstreams are rewritten to the prefixed names.

Build public hostnames from `<SERVICE>_SERVICE_NAME`, not a fixed name, so two copies of a template don't claim the same host. Prefer `STOAT_DOMAIN` over `{{ DNS }}` when the value should follow domain changes: `${APP_HOST:-app.${STOAT_DOMAIN}}:8080/https`.

`x-ports` follows Uncloud: `[hostname:]container_port/https` for HTTP(S) ingress, and `published:container/tcp@host` (or `/udp@host`) for raw TCP or UDP. Uncloud does not route TCP or UDP through ingress, so those ports need `@host`.

For a `postgresql` database, include `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`, and put the Postgres service first in `compose.yaml`. The service page builds:

- an **internal** URL at `<prefix>-<compose-service>.internal:5432`
- an **external** URL only when that service publishes container port 5432 over TCP (`ports` or Uncloud `x-ports`)

## Secret placeholders

Placeholders in `.env` values and in `compose.yaml` (the app's and every companion's) are expanded **once**, when the resource is created. Each placeholder generates a new value.

| Placeholder  | Result                                                                        |
| ------------ | ----------------------------------------------------------------------------- |
| `{{ UUID }}` | A random UUID (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)                        |
| `{{ 32 }}`   | A random 32-character base64 string (`A–Z`, `a–z`, `0–9`, `+`, `/`)           |
| `{{ DNS }}`  | The cluster's reserved domain, e.g. `files.{{ DNS }}` → `files.abc.uncld.dev` |

Spaces inside the braces are optional and case is ignored (`{{uuid}}` and `{{32}}` work). `{{ N }}` accepts any length from 1 to 256. Its output can contain `/` and `+`, so use `{{ UUID }}` for a secret that ends up inside a URL (a password in `DATABASE_URL`). Creating a template that uses `{{ DNS }}` fails when the cluster has no reserved domain.

Example `.env`:

```
POSTGRES_USER=postgres
POSTGRES_PASSWORD={{ 32 }}
POSTGRES_DB=app
API_TOKEN={{ UUID }}
```

Do not reuse the same placeholder when two fields must share a value: each `{{ }}` is generated independently. Put the secret in one environment variable and reference that variable from compose instead.
