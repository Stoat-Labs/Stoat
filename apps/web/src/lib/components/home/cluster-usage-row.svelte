<script lang="ts">
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        Meter,
        MeterIndicator,
        MeterTrack,
    } from "$lib/components/ui/meter";
    import { orpc, queryClient } from "$lib/api/orpc";
    import { cn } from "$lib/utils";
    import { createQuery } from "@tanstack/svelte-query";

    type Cluster = {
        id: string;
        name: string;
        projectCount: number;
        diagnosticsPending?: boolean;
        diagnostics: {
            status: "healthy" | "degraded";
            machines: { state: string }[];
        } | null;
    };

    let { cluster }: { cluster: Cluster } = $props();

    const metricsQuery = createQuery(() =>
        orpc.cluster.getClusterMetrics.queryOptions({
            input: { clusterId: cluster.id },
            refetchInterval: 60_000,
            staleTime: 30_000,
        }),
    );

    const metrics = $derived(metricsQuery.data);

    const machines = $derived(cluster.diagnostics?.machines ?? []);

    const onlineMachines = $derived(
        machines.filter(
            (machine) => machine.state.toLowerCase() === "up",
        ).length,
    );

    function bytes(value: number) {
        const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
        let index = 0;

        while (value >= 1024 && index < units.length - 1) {
            value /= 1024;
            index++;
        }

        return {
            value:
                value >= 100 || index === 0
                    ? value.toFixed(0)
                    : value.toFixed(1),
            unit: units[index],
        };
    }

    function formatBytes(used: number, total: number) {
        const t = bytes(total);
        const u = bytes(used);

        return u.unit === t.unit
            ? `${u.value} / ${t.value} ${t.unit}`
            : `${u.value} ${u.unit} / ${t.value} ${t.unit}`;
    }

    function cores(value: number) {
        return value < 10
            ? value.toFixed(2).replace(/0$/u, "")
            : value.toFixed(1);
    }

    const usage = $derived(metrics?.available ? metrics : null);

    const stats = $derived([
        {
            label: "CPU",
            usage: usage?.cpu,
            text:
                usage?.cpu &&
                `${cores(usage.cpu.used)} / ${usage.cpu.total} vCPU`,
        },
        {
            label: "Memory",
            usage: usage?.memory,
            text:
                usage?.memory &&
                formatBytes(usage.memory.used, usage.memory.total),
        },
        {
            label: "Disk",
            usage: usage?.disk,
            text:
                usage?.disk &&
                formatBytes(usage.disk.used, usage.disk.total),
        },
    ]);

    function meterTone(ratio: number) {
        return ratio >= 0.9
            ? "bg-destructive"
            : ratio >= 0.75
              ? "bg-warning"
              : "bg-primary";
    }
</script>

<li
    class="relative grid gap-x-6 gap-y-3 px-5 py-4 transition-colors hover:bg-accent/40 md:grid-cols-[minmax(0,14rem)_minmax(0,1fr)] md:items-center"
>
    <div class="min-w-0">
        <div class="flex min-w-0 items-center gap-2">
            <a
                href="/clusters/{cluster.id}"
                class="truncate text-sm font-semibold before:absolute before:inset-0 hover:underline"
            >
                {cluster.name}
            </a>
            {#if cluster.diagnosticsPending}
                <Skeleton
                    loading
                    loading-label="Checking cluster health"
                >
                    <Badge variant="secondary">Checking</Badge>
                </Skeleton>
            {:else if cluster.diagnostics?.status === "healthy"}
                <Badge variant="success">Healthy</Badge>
            {:else if cluster.diagnostics?.status === "degraded"}
                <Badge variant="warning">Degraded</Badge>
            {:else}
                <Badge variant="secondary">Health unavailable</Badge>
            {/if}
        </div>
        <p class="mt-0.5 truncate text-xs text-muted-foreground">
            {#if machines.length}
                {onlineMachines}/{machines.length}
                {machines.length === 1 ? "machine" : "machines"} up ·
            {/if}
            {cluster.projectCount}
            {cluster.projectCount === 1 ? "project" : "projects"}
        </p>
    </div>

    <div class="min-w-0 space-y-3">
        <dl class="grid gap-4 sm:grid-cols-3">
            {#each stats as stat (stat.label)}
                {@const ratio =
                    stat.usage && stat.usage.total > 0
                        ? Math.min(
                              1,
                              Math.max(
                                  0,
                                  stat.usage.used / stat.usage.total,
                              ),
                          )
                        : 0}
                <div class="min-w-0 space-y-1.5">
                    <dt class="text-xs text-muted-foreground">
                        {stat.label}
                    </dt>
                    <dd>
                        <Skeleton
                            loading={metricsQuery.isPending}
                            loading-label={`Loading ${stat.label} usage`}
                        >
                            <p
                                class="truncate text-sm font-medium tabular-nums"
                            >
                                {stat.text ??
                                    (metricsQuery.isPending
                                        ? "0 / 0 units"
                                        : "No data")}
                            </p>
                            {#if stat.usage}
                                <Meter
                                    value={Math.round(ratio * 100)}
                                    aria-label={`${stat.label} usage`}
                                >
                                    <MeterTrack
                                        class="mt-1.5 h-1.5 rounded-full"
                                    >
                                        <MeterIndicator
                                            class={cn(
                                                "rounded-full",
                                                meterTone(ratio),
                                            )}
                                        />
                                    </MeterTrack>
                                </Meter>
                            {:else}
                                <div
                                    class="mt-1.5 h-1.5 rounded-full bg-muted"
                                ></div>
                            {/if}
                        </Skeleton>
                    </dd>
                </div>
            {/each}
        </dl>
        {#if metricsQuery.isError || (metrics && !metrics.available)}
            <div
                class="flex flex-wrap items-center justify-between gap-2"
            >
                <p
                    class="text-xs text-muted-foreground"
                    role="status"
                >
                    {#if metrics && !metrics.available && metrics.reason === "uninitialized"}
                        Monitoring is not set up. Initialize this
                        cluster to see resource usage.
                    {:else}
                        Usage metrics are unavailable. Check the
                        cluster connection and monitoring services.
                    {/if}
                </p>
                <Button
                    class="relative z-10"
                    size="sm"
                    variant="outline"
                    disabled={metricsQuery.isFetching}
                    onclick={() => {
                        void metricsQuery.refetch();
                        void queryClient.invalidateQueries({
                            queryKey: orpc.cluster.healthz.key({
                                input: { clusterId: cluster.id },
                            }),
                        });
                    }}
                >
                    {metricsQuery.isFetching ? "Retrying…" : "Retry"}
                </Button>
            </div>
        {/if}
    </div>
</li>
