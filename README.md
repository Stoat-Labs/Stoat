<div align="center">
  <img src="apps/web/static/stoat.png" alt="Stoat Logo" width="120" height="120">

  <h1 align="center">Stoat</h1>

  <p align="center">
    <strong>A self-hosted PaaS (Platform as a Service) built on top of <a href="https://uncloud.run/">Uncloud</a>.</strong>
  </p>

  <p align="center">
    <img src="https://shieldcn.dev/group/github/stars/iRazvan2745/Stoat+github/forks/iRazvan2745/Stoat+github/license/iRazvan2745/Stoat.svg?variant=outline" alt="badges">
  </p>
</div>
<br/>

## Features

Stoat sits between the simplicity of Docker and the complexity of Kubernetes: deploy Compose apps across your own machines from a single dashboard.

- **Clusters** - Connect Uncloud clusters and manage every machine from one place.
- **Projects & Resources** - Group your services into projects and deploy them from Compose files.
- **Templates** - One-click deploys for common apps (PostgreSQL, Jellyfin, Seafile, ...). See [TEMPLATES.md](TEMPLATES.md).
- **Git** - Connect GitHub (incl. Enterprise), Forgejo or any Git server via token, SSH or OAuth, then deploy and push Compose files straight from your repos.
- **Variables** - Per-resource environment variables.
- **Deployments** - Deployment history with live build/deploy logs.
- **Logs** - Live log tailing and historical search per resource.
- **Observability** - Cluster metrics and logs, powered by a monitoring stack (GreptimeDB + Alloy) Stoat deploys for you.
- **Organizations** - Multi-tenant with team roles.
- **Self-Hostable** - Your servers, your data.

## How it works

Stoat does not talk to your servers directly. A small Go **sidecar** runs globally on every machine in your Uncloud cluster and exposes the Uncloud API over HTTP (protected by a bearer token). The Stoat dashboard connects to that sidecar to deploy services, stream logs and run jobs such as resource deployments. Long-running work (initializing clusters, deploying resources) runs in a background worker backed by Postgres.

## Getting Started

### Prerequisites

- An [Uncloud](https://uncloud.run/) cluster
- Docker & Docker Compose

### Install

1. **Deploy the sidecar on your cluster**

    ```bash
    cd apps/sidecar
    export SIDECAR_TOKEN="$(openssl rand -hex 32)"
    uc deploy -f docker-compose.yml
    ```

    Keep the token safe, it is effectively root on your machines. See [apps/sidecar/README.md](apps/sidecar/README.md).

2. **Download `compose.yml` and `.env.example`**

    ```bash
    git clone https://github.com/iRazvan2745/Stoat.git && cd Stoat
    ```

    ```bash
    BETTER_AUTH_SECRET=change_me_to_a_secure_secret # openssl rand -hex 32
    BETTER_AUTH_URL=http://localhost:3001
    DATABASE_URL=postgresql://postgres:password@localhost:5435/stoat
    ```

3. **Start Stoat**

    ```bash
    docker compose up -d
    ```

4. Open `http://localhost:3001`, create your account and add your cluster. Enjoy :D

<!--## Project Structure

```bash
stoat/
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

Kudos to the creators, maintainers and contributors of [Coolify](https://coolify.io/) and [Dokploy](https://dokploy.com/), these 2 are the inspiration that Stoat is based on. Coolify's way of being more of a PaaS and Dokploy's of being more of a "docker harness". But none the less the deployment software that sits in the middle of the simplicity of docker and complexity of kubernetes, [Uncloud](https://uncloud.run/). ♥️

---

## Star History

<a href="https://www.star-history.com/#iRazvan2745/Stoat&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=iRazvan2745/Stoat&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=iRazvan2745/Stoat&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=iRazvan2745/Stoat&type=Date" />
 </picture>
</a>

<div align="center">
  <sub>Built with ❤️ by irazz</sub>
</div>
