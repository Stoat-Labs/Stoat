<div align="center">
  <img src="apps/web/static/clowder.svg" alt="Clowder Logo" width="120" height="120">

  <h1 align="center">Clowder</h1>

  <p align="center">
    <strong>A self-hosted PaaS (Platform as a Service) built on top of <a href="https://uncloud.run/">Uncloud</a>.</strong>
  </p>

  <p align="center">
    <img src="https://shieldcn.dev/group/github/stars/clowder-run/Clowder+github/forks/clowder-run/Clowder+github/license/clowder-run/Clowder.svg?variant=outline" alt="badges">
  </p>
</div>
<br/>

<!-- <img width="2240" height="1337" alt="image" src="https://github.com/user-attachments/assets/23fdd9c0-b7e0-4926-b6af-1bc202e97e25" /> -->
<img width="2258" height="1355" alt="image" src="https://github.com/user-attachments/assets/8c89768c-b6ec-4808-9339-f970b037556c" />

## Features

Clowder allows you to manage multiple [Uncloud](https://uncloud.run) clusters from a single dashboard.

- **Clusters** - Connect Uncloud clusters, or create one on a fresh server over SSH, and manage every machine from one place.
- **Projects & Resources** - Group your services into projects and deploy them from Compose files.
- **Templates** - One-click deploys for common apps and databases.
- **Git** - Connect Forgejo, GitHub (incl. Enterprise) or any Git server via token, SSH or OAuth, then deploy and push Compose files straight from your repos.
- **Variables** - Per-resource environment variables.
- **Deployments** - Deployment history with live build/deploy logs.
- **Logs** - Live log tailing and historical search per resource.
- **Observability** - Cluster metrics and logs, powered by a monitoring stack (GreptimeDB + Alloy) Clowder deploys for you.
- **S3 Buckets** - Rustfs and Cloudflare R2 integration to create buckets and isolated access keys.
- **Multi Cluster** - You can use multiple uncloud clusters, each project gets its own clusters. (Multiple projects can still use the same cluster)
- **Organizations** - Multi-tenant.
- **Self-Hostable** - Your servers, your data.

## How it works

Clowder does not keep SSH keys to your servers like similar apps. A small **sidecar** runs globally on every machine in your Uncloud cluster and exposes the Uncloud API over HTTP. The Clowder dashboard connects to that sidecar to deploy services, stream logs and run jobs such as resource deployments. Long-running work (creating and initializing clusters, deploying resources) runs in a background worker backed by Postgres.

To create a cluster from the dashboard, Clowder generates a single-use SSH key for that server. Once you add its public key to the server, Clowder runs `uc machine init` over SSH, deploys the sidecar at `https://<server>:51443` with a self-signed certificate that Clowder generates and pins, and connects to it. No domain or certificate authority sits in between, so port 51443 only needs to be open to Clowder. The private key is deleted as soon as the cluster is ready. The server needs a root user or one with passwordless sudo.

Adding a machine to a cluster works the same way: Clowder generates a single-use key for the new server and runs `uc machine add` over SSH, reaching the cluster through its sidecar rather than SSH on an existing machine. It then starts the sidecar, Caddy and monitoring on the new machine, points the cluster's `uncld.dev` domain at it when it's a public server, and deletes the key once it has joined. Machines talk to each other over WireGuard on UDP port 51820, so a host firewall such as firewalld must let in that port and traffic on Uncloud's `uncloud` interface. Removing a machine works like `uc machine rm`: its containers are removed and the server is reset so it can be added again. A machine that's down is only taken out of the cluster, so run `uncloud-uninstall` on it before adding it again. The machine Clowder connects through can't be removed.

Public servers also get a free `uncld.dev` domain for your apps, which needs ports 80 and 443 open to the internet. Servers on a private network or Tailscale (`100.64.0.0/10`) get no public domain. The sidecar URL uses the address you enter, so give cloud servers a static IP (an Elastic IP on EC2) or a hostname.

## Getting Started

### Prerequisites

- A Linux server you can SSH into as `root`, or as a user with passwordless sudo.
- A domain with a DNS record pointing to that server, or the server's LAN or Tailscale IP address (browsers then warn about Caddy's own certificate until you trust the root certificate the installer saves)

### Quick Install

Run this on your own computer:

```bash
curl -fsSL https://raw.githubusercontent.com/clowder-run/Clowder/master/scripts/install.sh | bash
```

The script installs the Uncloud CLI if it's missing, sets up an [Uncloud](https://uncloud.run/) cluster on your server (or uses the one you already have), generates `.env` with random secrets and deploys Clowder with `uc deploy`. When it's done, open your domain or IP address and follow the setup wizard: the first account becomes the instance admin, then you name your organization and connect your cluster with the sidecar URL and token the script prints.

### Manual install

If you already have an [Uncloud](https://uncloud.run/) cluster and the Uncloud CLI, you can also set Clowder up by hand:

1. **Download `compose.yml` and `.env.example`**

    ```bash
    APP_URL=clowder.example.com
    APP_SECRET=changeme                   # openssl rand -hex 32 # this is used to encrypt secrets, dont lose it
    POSTGRES_PASSWORD=changeme            # openssl rand -hex 32
    SIDECAR_TOKEN=changeme                # openssl rand -hex 32 # please remember this one you'll need to use it when adding your cluster
    REDIS_URL=redis://stoat-cache.internal:6379
    APP_USE_INTERNAL_CACHE=false          # true adds a per-replica memory cache in front of Redis (single replica only)
    USE_INTERNAL_WORKER=true              # false only with the stoat-worker service in compose.yml enabled
    ```

2. **Start Clowder**

    ```bash
    uc deploy
    ```

3. Open `https://clowder.example` or whatever you set and follow the setup wizard: the first account becomes the instance admin, then you name your organization and connect your cluster (sidecar URL `http://sidecar.internal`, token is your `SIDECAR_TOKEN`). Enjoy :D

<!--## Project Structure

```bash
clowder/
├── apps/
│   ├── web/           # Dashboard + API (SvelteKit)
│   └── sidecar/       # Uncloud HTTP API, runs on every machine (Go)
├── packages/
│   ├── api/           # oRPC routers & business logic
│   ├── auth/          # Authentication configuration
│   ├── db/            # Database schema, queries & migrations (Drizzle)
│   ├── uncloud/       # TypeScript client for the sidecar
│   ├── workflows/     # Background jobs (cluster init, deployments)
│   └── config/        # Shared configuration
├── templates/         # One-click app templates
└── tests/             # TypeScript tests
```-->

## 📄 License

This project is licensed under the [Apache 2.0 License](LICENSE).

## Credits

Kudos to the contributors of [Coolify](https://coolify.io/) and [Dokploy](https://dokploy.com/), these 2 are the inspiration that Clowder is based on. Coolify's way of being more of a PaaS and Dokploy's of being closer to docker compose. The software Clowder uses [Uncloud](https://uncloud.run/). And Railway for letting me copy their ui lol, great platform if you dont want to manage your own infrastructure ♥️

## Sponsors

[![Greptile: The War on Bugs](https://www.greptile.com/badge.svg)](https://www.greptile.com/?utm_source=oss_badge&utm_medium=readme&utm_campaign=greptile_for_open_source)

## Screenshots

<img width="2242" height="1334" alt="image" src="https://github.com/user-attachments/assets/c3ac1f85-a097-4f1e-a603-a5d183ef8dbd" />
<img width="2242" height="1336" alt="image" src="https://github.com/user-attachments/assets/6cc931ac-b1d0-4dd8-b1a1-3f2f302f00f0" />
<img width="2243" height="1338" alt="image" src="https://github.com/user-attachments/assets/27913699-748c-46f0-9b0a-55d0a47005f6" />
<img width="2248" height="1336" alt="image" src="https://github.com/user-attachments/assets/6d69d901-efc5-4f3e-89a0-63e42de5f65e" />
<img width="2240" height="1338" alt="image" src="https://github.com/user-attachments/assets/6a5b98b9-4c83-4e71-acfa-674291b77730" />
<img width="2241" height="1337" alt="image" src="https://github.com/user-attachments/assets/7b059d7c-bfa4-4a10-ab08-3cd44cd3025b" />

and there's more...

---

## Star History

<a href="https://www.star-history.com/#clowder-run/Clowder&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=clowder-run/Clowder&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=clowder-run/Clowder&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=clowder-run/Clowder&type=Date" />
 </picture>
</a>

<div align="center">
  <sub>Built with ❤️ by irazz</sub>
</div>
