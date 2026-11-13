<script lang="ts">
    import { Badge } from "$lib/components/ui/badge";
    import {
        Button,
        buttonVariants,
    } from "$lib/components/ui/button";
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
        Menu,
        MenuItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import {
        Table,
        TableBody,
        TableCell,
        TableHead,
        TableHeader,
        TableRow,
    } from "$lib/components/ui/table";
    import Activity from "phosphor-svelte/lib/PulseIcon";
    import Ellipsis from "phosphor-svelte/lib/DotsThreeIcon";
    import Plus from "phosphor-svelte/lib/PlusIcon";
    import Server from "phosphor-svelte/lib/HardDrivesIcon";
    import Trash2 from "phosphor-svelte/lib/TrashIcon";
    import type { AppRouterClient } from "@clowder/api/routers/index";

    type Machine = NonNullable<
        NonNullable<
            Awaited<
                ReturnType<AppRouterClient["cluster"]["getCluster"]>
            >
        >["diagnostics"]
    >["machines"][number];

    // Without onadd and onremove, as for members, machines can't be added or removed.
    let {
        machines,
        onadd,
        onremove,
    }: {
        machines: Machine[];
        onadd?: () => void;
        onremove?: (machine: Machine) => void;
    } = $props();

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
        class="flex-row items-start justify-between gap-3 px-2.5 py-3"
    >
        <div class="min-w-0">
            <FrameTitle>Machines</FrameTitle>
            <FrameDescription>
                Members reported by the Uncloud control plane.
            </FrameDescription>
        </div>
        <div class="flex shrink-0 items-center gap-2">
            {#if onadd}
                <Button size="sm" onclick={onadd}>
                    <Plus class="size-4" aria-hidden="true" />
                    Add machine
                </Button>
            {/if}
        </div>
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
                    <TableHead>
                        <span>Machine</span>
                        <Badge variant="secondary">
                            {machines.length}
                        </Badge>
                    </TableHead>
                    <TableHead class="text-center">State</TableHead>
                    <TableHead class="text-center">
                        Versions
                    </TableHead>
                    <TableHead class="text-center">
                        WireGuard
                    </TableHead>
                    {#if onremove}
                        <TableHead class="w-10">
                            <span class="sr-only">Actions</span>
                        </TableHead>
                    {/if}
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
                                            class="mt-1 block text-xs wrap-break-word text-destructive-foreground"
                                        >
                                            {machine.error}
                                        </span>
                                    {/if}
                                    {#if machine.connected}
                                        <span
                                            class="mt-1 block text-xs text-muted-foreground"
                                        >
                                            Clowder connects through
                                            this machine
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
                        {#if onremove}
                            <TableCell class="text-end">
                                <!-- Clowder can't remove the machine it reaches the cluster through. -->
                                {#if !machine.connected}
                                    <Menu>
                                        <MenuTrigger
                                            class={buttonVariants({
                                                variant: "ghost",
                                                size: "icon-sm",
                                            })}
                                            aria-label={`Actions for ${machine.name}`}
                                        >
                                            <Ellipsis
                                                class="size-4"
                                                aria-hidden="true"
                                            />
                                        </MenuTrigger>
                                        <MenuPopup align="end">
                                            <MenuItem
                                                variant="destructive"
                                                onclick={() =>
                                                    onremove?.(
                                                        machine,
                                                    )}
                                            >
                                                <Trash2
                                                    aria-hidden="true"
                                                />
                                                Remove machine
                                            </MenuItem>
                                        </MenuPopup>
                                    </Menu>
                                {/if}
                            </TableCell>
                        {/if}
                    </TableRow>
                {/each}
            </TableBody>
        </Table>
    {/if}
</Frame>
