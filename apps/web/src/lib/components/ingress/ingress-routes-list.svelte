<script lang="ts">
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Empty,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
    } from "$lib/components/ui/empty";
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Separator } from "$lib/components/ui/separator";
    import ArrowRight from "@lucide/svelte/icons/arrow-right";
    import Globe from "@lucide/svelte/icons/globe";
    import Network from "@lucide/svelte/icons/network";
    import Pencil from "@lucide/svelte/icons/pencil";
    import Plus from "@lucide/svelte/icons/plus";
    import Server from "@lucide/svelte/icons/server";
    import Trash2 from "@lucide/svelte/icons/trash-2";
    import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
    import type {
        CaddyIngress,
        CaddyRoute,
        HttpIngress,
        HostIngress,
        IngressEntry,
    } from "@stoat/workflows/ingress";

    type ListRow =
        | { kind: "port"; entry: HttpIngress | HostIngress }
        | {
              kind: "caddy-route";
              entry: CaddyIngress;
              route: CaddyRoute;
          }
        | { kind: "caddy"; entry: CaddyIngress };

    let {
        entries,
        caddyRoutes,
        services,
        readOnly = false,
        disabled = false,
        onadd,
        onedit,
        onremoveentry,
        onremovecaddy,
    }: {
        entries: IngressEntry[];
        caddyRoutes: CaddyRoute[];
        services: string[];
        readOnly?: boolean;
        disabled?: boolean;
        onadd: () => void;
        onedit: (entry: IngressEntry) => void;
        onremoveentry: (entry: HttpIngress | HostIngress) => void;
        onremovecaddy: (entry: CaddyIngress) => void;
    } = $props();

    const listRows = $derived.by(() => {
        const rows: ListRow[] = [];

        for (const entry of entries) {
            if (entry.kind !== "caddy") {
                rows.push({ kind: "port", entry });

                continue;
            }

            let matched = false;

            for (const route of caddyRoutes) {
                if (route.serviceName !== entry.service) continue;

                matched = true;
                rows.push({ kind: "caddy-route", entry, route });
            }

            if (!matched) rows.push({ kind: "caddy", entry });
        }

        return rows;
    });
</script>

<Frame role="region" aria-labelledby="ingress-list-heading">
    <FrameHeader
        class="shrink-0 flex-row flex-wrap items-start justify-between gap-2"
    >
        <div class="min-w-0">
            <FrameTitle class="text-base">
                <h2 id="ingress-list-heading">Published routes</h2>
            </FrameTitle>
            <FrameDescription class="mt-1">
                Backed by x-ports and x-caddy in the Compose file.
            </FrameDescription>
        </div>
        {#if !readOnly}
            <Button
                size="sm"
                disabled={disabled || services.length === 0}
                onclick={onadd}
            >
                <Plus class="size-4" aria-hidden="true" />
                Create ingress
            </Button>
        {/if}
    </FrameHeader>
    <FramePanel class="max-h-96 overflow-y-auto p-0 xl:max-h-none">
        {#if services.length === 0}
            <Empty
                class="m-3 rounded-xl border border-dashed border-border p-4 md:py-4"
            >
                <EmptyHeader>
                    <EmptyDescription>
                        This Compose file has no services yet. Add a
                        service in the Compose editor first.
                    </EmptyDescription>
                </EmptyHeader>
            </Empty>
        {:else if entries.length === 0}
            <Empty
                class="m-3 rounded-xl border border-dashed border-border p-4 md:py-4"
            >
                <EmptyHeader>
                    <EmptyMedia variant="icon">
                        <Globe aria-hidden="true" />
                    </EmptyMedia>
                    <EmptyDescription>
                        No ingress yet. HTTPS entries look like
                        <span class="font-mono">
                            example.com:8000/https
                        </span>
                        ; host ports end with
                        <span class="font-mono">@host</span>
                        .
                    </EmptyDescription>
                </EmptyHeader>
            </Empty>
        {:else}
            <ul>
                {#each listRows as row, index (row.kind === "port" ? `${row.entry.service}-${row.entry.raw}` : row.kind === "caddy-route" ? `caddy-${row.entry.service}-${row.route.host}-${row.route.path ?? ""}` : `caddy-${row.entry.service}`)}
                    <li class="min-w-0">
                        {#if index > 0}<Separator />{/if}
                        <div
                            class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 p-3"
                        >
                            <span
                                class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                            >
                                {#if row.kind === "port" && row.entry.kind === "http"}
                                    <Globe
                                        class="size-5"
                                        aria-hidden="true"
                                    />
                                {:else if row.kind === "port"}
                                    <Network
                                        class="size-5"
                                        aria-hidden="true"
                                    />
                                {:else}
                                    <Server
                                        class="size-5"
                                        aria-hidden="true"
                                    />
                                {/if}
                            </span>
                            <div class="min-w-0 flex-1">
                                {#if row.kind === "port" && row.entry.kind === "http"}
                                    <h3
                                        class="truncate font-mono text-sm font-medium leading-5"
                                        title={row.entry.raw}
                                    >
                                        {row.entry.protocol}://{row
                                            .entry.hostname ??
                                            "<cluster-domain>"}
                                        <span
                                            class="text-muted-foreground"
                                        >
                                            <ArrowRight
                                                class="mx-1 inline size-3.5 shrink-0 align-[-2px]"
                                                aria-hidden="true"
                                            />
                                            {row.entry.service}:{row
                                                .entry.containerPort}
                                        </span>
                                    </h3>
                                    <p
                                        class="mt-1 truncate font-mono text-xs leading-5 text-muted-foreground"
                                    >
                                        {row.entry.raw}
                                    </p>
                                {:else if row.kind === "port" && row.entry.kind === "host"}
                                    <h3
                                        class="truncate font-mono text-sm font-medium leading-5"
                                        title={row.entry.raw}
                                    >
                                        {row.entry.bind ?? "*"}:{row
                                            .entry.hostPort}
                                        <span
                                            class="text-muted-foreground"
                                        >
                                            <ArrowRight
                                                class="mx-1 inline size-3.5 shrink-0 align-[-2px]"
                                                aria-hidden="true"
                                            />
                                            {row.entry.service}:{row
                                                .entry.containerPort}
                                            ({row.entry.protocol})
                                        </span>
                                    </h3>
                                    <p
                                        class="mt-1 truncate font-mono text-xs leading-5 text-muted-foreground"
                                    >
                                        {row.entry.raw} · bypasses Caddy
                                    </p>
                                {:else if row.kind === "caddy-route"}
                                    <h3
                                        class="truncate font-mono text-sm font-medium leading-5"
                                    >
                                        <a
                                            href={`${row.route.protocol}://${row.route.host}${row.route.path?.replace(/\*$/u, "") ?? ""}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            class="underline decoration-muted-foreground underline-offset-2 hover:text-foreground"
                                            title={`${row.route.protocol}://${row.route.host}${row.route.path ?? ""}`}
                                        >
                                            {row.route
                                                .protocol}://{row
                                                .route.host}{row.route
                                                .path ?? ""}
                                        </a>
                                        <span
                                            class="text-muted-foreground"
                                        >
                                            <ArrowRight
                                                class="mx-1 inline size-3.5 shrink-0 align-[-2px]"
                                                aria-hidden="true"
                                            />
                                            {row.route
                                                .upstreamService}{row
                                                .route
                                                .containerPort ===
                                            undefined
                                                ? ""
                                                : `:${row.route.containerPort}`}
                                        </span>
                                    </h3>
                                    <p
                                        class="mt-1 truncate font-mono text-xs leading-5 text-muted-foreground"
                                        title={`x-caddy on ${row.entry.service}`}
                                    >
                                        x-caddy on {row.entry.service}
                                    </p>
                                {:else if row.kind === "caddy"}
                                    <h3
                                        class="truncate text-sm font-medium leading-5"
                                    >
                                        Custom Caddy ·
                                        {row.entry.service}
                                    </h3>
                                    <p
                                        class="mt-1 truncate font-mono text-xs leading-5 text-muted-foreground"
                                        title={row.entry.fileRef
                                            ? row.entry.caddy
                                            : row.entry.caddy.split(
                                                  "\n",
                                              )[0]}
                                    >
                                        {row.entry.fileRef
                                            ? `File: ${row.entry.caddy.trim()}`
                                            : (row.entry.caddy.split(
                                                  "\n",
                                              )[0] ??
                                              row.entry.caddy)}
                                    </p>
                                {/if}
                            </div>
                            <div
                                class="flex shrink-0 flex-wrap items-center gap-1.5"
                            >
                                {#if row.kind === "port" && row.entry.kind === "http"}
                                    <Badge variant="secondary">
                                        {row.entry.service}
                                    </Badge>
                                    <Badge
                                        variant={row.entry
                                            .protocol === "https"
                                            ? "success"
                                            : "warning"}
                                    >
                                        {row.entry.protocol}
                                    </Badge>
                                {:else if row.kind === "port" && row.entry.kind === "host"}
                                    <Badge variant="secondary">
                                        {row.entry.service}
                                    </Badge>
                                    <Badge variant="outline">
                                        {row.entry.protocol}
                                    </Badge>
                                {:else if row.kind === "caddy-route"}
                                    {#if row.route.path}
                                        <Badge variant="outline">
                                            {row.route.path}
                                        </Badge>
                                    {/if}
                                    <Badge variant="secondary">
                                        {row.route.upstreamService}
                                    </Badge>
                                    <Badge
                                        variant={row.route
                                            .protocol === "https"
                                            ? "success"
                                            : "warning"}
                                    >
                                        {row.route.protocol}
                                    </Badge>
                                {:else if row.kind === "caddy"}
                                    <Badge variant="secondary">
                                        {row.entry.service}
                                    </Badge>
                                    {#if row.entry.fileRef}
                                        <Badge variant="warning">
                                            <TriangleAlert
                                                class="size-3"
                                                aria-hidden="true"
                                            />
                                            File ref
                                        </Badge>
                                    {:else}
                                        <Badge variant="outline">
                                            x-caddy
                                        </Badge>
                                    {/if}
                                {/if}
                                {#if !readOnly}
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={row.kind ===
                                        "caddy"
                                            ? `Edit custom Caddy for ${row.entry.service}`
                                            : row.kind ===
                                                "caddy-route"
                                              ? `Edit Caddy routes for ${row.entry.service}`
                                              : `Edit ${row.entry.raw}`}
                                        {disabled}
                                        onclick={() =>
                                            onedit(row.entry)}
                                    >
                                        <Pencil
                                            class="size-4"
                                            aria-hidden="true"
                                        />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon-sm"
                                        aria-label={row.kind ===
                                        "port"
                                            ? `Remove ${row.entry.raw}`
                                            : `Remove custom Caddy from ${row.entry.service}`}
                                        {disabled}
                                        onclick={() =>
                                            row.kind === "port"
                                                ? onremoveentry(
                                                      row.entry,
                                                  )
                                                : onremovecaddy(
                                                      row.entry,
                                                  )}
                                    >
                                        <Trash2
                                            class="size-4"
                                            aria-hidden="true"
                                        />
                                    </Button>
                                {/if}
                            </div>
                        </div>
                    </li>
                {/each}
            </ul>
        {/if}
    </FramePanel>
</Frame>
