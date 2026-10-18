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

Stoat lists every valid app under this directory on the **New resource** page (`/projects/<projectId>/create`). Apps tagged `database` appear under **Databases**; everything else appears under **Templates**. Templates are bundled into the app at build time, so rebuild after adding or changing one.

## Layout

| Path                                                | Required | Purpose                                                                                          |
| --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `templates/<appid>/manifest.json`                   | yes      | Display name, description, and service type                                                      |
| `templates/<appid>/logo.svg` or `logo.png`          | no       | Icon on the template card. Copy from [svgl.app](https://svgl.app), or set `icon` in the manifest |
| `templates/<appid>/versions/<version>/compose.yaml` | yes      | Compose file deployed for this version (`compose.yml` is also accepted)                          |
| `templates/<appid>/versions/<version>/.env`         | no       | Environment variables seeded onto the service                                                    |

`<appid>` and `<version>` must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`. Versions are sorted newest-first using numeric comparison (`18` > `16`, `1.10` > `1.9`).

Apps with a missing or invalid manifest, or with no version folders, are skipped.

## `manifest.json`

```json
{
    "name": "PostgreSQL",
    "description": "Relational database for apps that need durable SQL storage.",
    "type": "postgresql",
    "icon": "postgresql",
    "tags": ["database"]
}
```

| Field         | Required | Notes                                                                                                                                |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `name`        | yes      | Shown on the template card and used as the default service name                                                                      |
| `description` | yes      | Short summary under the name. Long text is truncated in the picker                                                                   |
| `type`        | yes      | Stored on the created service. Use `compose` for a generic app. Use `postgresql` to get the connection URL panel on the service page |
| `icon`        | no       | [SVGL](https://svgl.app) slug, without `.svg` (for example `postgresql`). Used when `logo.svg` / `logo.png` is missing               |
| `tags`        | no       | Category pills on the template card (`database`, `cache`, `proxy`, …). `database` moves the app into the Databases group             |

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

Creating the template creates one canvas resource per folder (`<name> Database` here). `engine` makes the companion a `database` resource; omit it for a plain `compose` one. A version only ships the companions it needs.

Variables stay with the resource that owns them. The app's `.env` reads what it needs with `{{ db.NAME }}`, which becomes a reference to the created resource (`{{ <resourceId>.NAME }}`), so the canvas draws the edge and the secret lives only on the database:

```
DB_HOST={{ db.POSTGRES_INTERNAL_HOST }}
DB_PASSWORD={{ db.POSTGRES_PASSWORD }}
```

`NAME` is a variable in the companion's `.env` or one of its built-ins (`<SERVICE>_INTERNAL_HOST`). References only work in `.env`, never in `compose.yaml`, so pass them to containers through a variable (`DB_HOST: ${DB_HOST}`). Required variables and secrets are collected across all the resources. A reference cannot point at another reference.

Resources deploy independently, so `depends_on` cannot cross them: the app may start before its database is healthy and relies on `restart: unless-stopped` to retry.

## Logo

Prefer a local `logo.svg` or `logo.png` under `templates/<appid>/`. Copy brand marks from [svgl.app](https://svgl.app) — search for the product, then save the SVG as `logo.svg`.

If there is no local file, set `"icon"` in the manifest to the SVGL library name. Stoat loads it from `https://api.svgl.app/svg/<icon>.svg`.

## Compose and environment

`compose.yaml` is copied onto the new service as-is (after secret expansion). Do not use `env_file: .env` or a fixed `container_name` — Stoat stores `.env` values as the service's Variables and substitutes them into the compose file at deploy time, so pass them to containers explicitly (`POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}`).

`.env` uses standard `NAME=value` syntax (quotes, `export`, and comments are supported). Those variables are created on the service so they can be edited under **Environment**.

Leave a value empty (`ADMIN_EMAIL=`) to make it required: the deploy screen asks for it and the service can't be created until it is set. Values are single-line.

Stoat also provides these variables at deploy time. A variable you define with the same name overrides any of them.

| Variable                  | Value                                                                     |
| ------------------------- | ------------------------------------------------------------------------- |
| `<SERVICE>_SERVICE_NAME`  | The service's deployed name, e.g. `a1b2c3d4-e5f6a7b8-my-db`               |
| `<SERVICE>_INTERNAL_HOST` | Its cluster-internal hostname, e.g. `a1b2c3d4-e5f6a7b8-my-db.internal`    |
| `STOAT_PREFIX`            | The resource prefix, or empty when prefixing is off                       |
| `STOAT_DOMAIN`            | The cluster's reserved domain, read on every deploy, e.g. `abc.uncld.dev` |

`<SERVICE>` is the service name uppercased with non-alphanumerics turned into `_` (`my-db` → `MY_DB`). Names include the prefix when prefixing is on; template services are always prefixed. Prefer `STOAT_DOMAIN` over `{{ DNS }}` when the value should follow domain changes: `${APP_HOST:-app.${STOAT_DOMAIN}}:8080/https`.

For PostgreSQL, include `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`. The service page builds:

- an **internal** URL at `<compose-service>.internal` (the Uncloud name after the service slug is prefixed)
- an **external** URL only when the compose file publishes a TCP port (`ports` or Uncloud `x-ports`)

## Secret placeholders

Placeholders in `.env` values and in `compose.yaml` are expanded **once**, when the service is created. Each placeholder generates a new value.

| Placeholder  | Result                                                                        |
| ------------ | ----------------------------------------------------------------------------- |
| `{{ UUID }}` | A random UUID (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)                        |
| `{{ 32 }}`   | A random 32-character base64 string (`A–Z`, `a–z`, `0–9`, `+`, `/`)           |
| `{{ DNS }}`  | The cluster's reserved domain, e.g. `files.{{ DNS }}` → `files.abc.uncld.dev` |

Spaces inside the braces are optional (`{{UUID}}` and `{{32}}` work). `{{ N }}` accepts any length from 1 to 256.

Example `.env`:

```
POSTGRES_USER=postgres
POSTGRES_PASSWORD={{ 32 }}
POSTGRES_DB=app
API_TOKEN={{ UUID }}
```

Do not reuse the same placeholder when two fields must share a value — each `{{ }}` is generated independently. Put the secret in one environment variable and reference that variable from compose instead.
