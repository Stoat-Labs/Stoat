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

<img width="2237" height="1332" alt="image" src="https://github.com/user-attachments/assets/01725fe7-3840-4b43-b302-262ff5b38667" />


## Features

Stoat sits between the simplicity of Docker and the complexity of Kubernetes: deploy Compose apps across your own machines from a single dashboard.

- **Clusters** - Connect Uncloud clusters and manage every machine from one place.
- **Projects & Resources** - Group your services into projects and deploy them from Compose files.
- **Templates** - One-click deploys for common apps and databases.
- **Git** - Connect Forgejo, GitHub (incl. Enterprise) or any Git server via token, SSH or OAuth, then deploy and push Compose files straight from your repos.
- **Variables** - Per-resource environment variables.
- **Deployments** - Deployment history with live build/deploy logs.
- **Logs** - Live log tailing and historical search per resource.
- **Observability** - Cluster metrics and logs, powered by a monitoring stack (GreptimeDB + Alloy) Stoat deploys for you.
- **S3 Buckets** - Rustfs and Cloudflare R2 integration to create buckets and isolated access keys.
- **Multi Cluster** - You can use multiple uncloud clusters, each project gets its own clusters. (Multiple projects can still use the same cluster)
- **Organizations** - Multi-tenant.
- **Self-Hostable** - Your servers, your data.

## How it works

Stoat does not talk to your servers directly. A small **sidecar** runs globally on every machine in your Uncloud cluster and exposes the Uncloud API over HTTP. The Stoat dashboard connects to that sidecar to deploy services, stream logs and run jobs such as resource deployments. Long-running work (initializing clusters, deploying resources) runs in a background worker backed by Postgres.

## Getting Started

### Prerequisites

- An [Uncloud](https://uncloud.run/) cluster
- Docker & Docker Compose

### Install

1. **Download `compose.yml` and `.env.example`**

    ```bash
    git clone https://github.com/Stoat-labs/Stoat.git && cd Stoat
    ```

    ```bash
    APP_URL=stoat.example.com
    APP_SECRET=changeme                   # openssl rand -hex 32 # this is used to encrypt secrets, dont lose it
    POSTGRES_PASSWORD=changeme            # openssl rand -hex 32
    SIDECAR_TOKEN=changeme                # openssl rand -hex 32 # please remember this one you'll need to use it when adding your cluster
    REDIS_URL=redis://stoat-cache.internal:6379
    ```

3. **Start Stoat**

    ```bash
    uc deploy
    ```

4. Open `https://stoat.example` or whatever you set and follow the setup wizard: the first account becomes the instance admin, then you name your organization and connect your cluster. Enjoy :D

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

## Screenshots

<img width="2239" height="1328" alt="image" src="https://github.com/user-attachments/assets/7b76f206-6e87-4571-ab97-e09b8ce9815b" />
<img width="2240" height="1332" alt="image" src="https://github.com/user-attachments/assets/786b2f71-a012-415d-bf7f-c6f4a4cd9b1a" />
<img width="2233" height="1328" alt="image" src="https://github.com/user-attachments/assets/1db12f13-2ebc-4822-97a0-11654006b6fd" />
<img width="2234" height="1329" alt="image" src="https://github.com/user-attachments/assets/ade3eb8e-84e6-4038-9056-936cdae6a294" />
and there's more...

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
