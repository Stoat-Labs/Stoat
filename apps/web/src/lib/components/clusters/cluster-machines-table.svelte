<script lang="ts">
    import { Badge } from "$lib/components/ui/badge";
    import {
        Empty,
        EmptyDescription,
        EmptyHeader,
    } from "$lib/components/ui/empty";
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import {
        Table,
        TableBody,
        TableCell,
        TableHead,
        TableHeader,
        TableRow,
    } from "$lib/components/ui/table";
    import Activity from "@lucide/svelte/icons/activity";
    import Server from "@lucide/svelte/icons/server";
    import type { AppRouterClient } from "@stoat/api/routers/index";

    type Machine = NonNullable<
        NonNullable<
            Awaited<
                ReturnType<AppRouterClient["cluster"]["getCluster"]>
            >
        >["diagnostics"]
    >["machines"][number];

    let { machines }: { machines: Machine[] } = $props();

    function stateVariant(
        state: string,
    ): "success" | "warning" | "error" {
        const normalized = state.toLowerCase();

        if (
            ["up", "ready", "running", "healthy"].includes(normalized)
        )
            return "success";

        if (
            ["down", "error", "failed", "unhealthy"].includes(
                normalized,
            )
        )
            return "error";

        return "warning";
    }
</script>

<Frame class="min-w-0">
    <FrameHeader
        class="flex-row flex-wrap items-start justify-between gap-3 px-2.5 py-3"
    >
        <div class="min-w-0">
            <FrameTitle>Machines</FrameTitle>
            <FrameDescription>
                Members reported by the Uncloud control plane.
            </FrameDescription>
        </div>
        <Badge variant="secondary">
            {machines.length}
        </Badge>
    </FrameHeader>
    {#if machines.length === 0}
        <Empty class="p-8 md:py-8">
            <EmptyHeader>
                <EmptyDescription>
                    No machines were reported for this cluster.
                </EmptyDescription>
            </EmptyHeader>
        </Empty>
    {:else}
        <Table variant="card">
            <TableHeader>
                <TableRow>
                    <TableHead>Machine</TableHead>
                    <TableHead class="text-center">State</TableHead>
                    <TableHead class="text-center">
                        Versions
                    </TableHead>
                    <TableHead class="text-center">
                        WireGuard
                    </TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {#each machines as machine (machine.id)}
                    <TableRow>
                        <TableCell class="min-w-48">
                            <div class="flex items-center gap-2.5">
                                <Server
                                    class="flex size-6 shrink-0 items-center justify-center text-muted-foreground rounded-lg"
                                    aria-hidden="true"
                                />
                                <span class="min-w-0">
                                    <span
                                        class="block truncate font-medium"
                                    >
                                        {machine.name}
                                    </span>
                                    {#if machine.error}
                                        <span
                                            class="mt-1 block text-xs break-words text-destructive-foreground"
                                        >
                                            {machine.error}
                                        </span>
                                    {/if}
                                </span>
                            </div>
                        </TableCell>
                        <TableCell class="text-center">
                            <Badge
                                variant={stateVariant(machine.state)}
                            >
                                {machine.state}
                            </Badge>
                        </TableCell>
                        <TableCell class="min-w-36 text-center">
                            <span class="block text-xs">
                                Daemon {machine.daemonVersion ??
                                    "Unknown"}
                            </span>
                            <span
                                class="mt-1 block text-xs text-muted-foreground"
                            >
                                Docker {machine.dockerVersion ??
                                    "Unknown"}
                            </span>
                        </TableCell>
                        <TableCell class="text-center">
                            {#if machine.wireGuard}
                                <span
                                    class="inline-flex items-center gap-1.5 text-sm"
                                >
                                    <Activity
                                        class="size-3.5 text-success-foreground"
                                        aria-hidden="true"
                                    />
                                    {machine.wireGuard.peers.length} peers
                                </span>
                            {:else}
                                <span
                                    class="text-xs text-muted-foreground"
                                >
                                    Unknown
                                </span>
                            {/if}
                        </TableCell>
                    </TableRow>
                {/each}
            </TableBody>
        </Table>
    {/if}
</Frame>
