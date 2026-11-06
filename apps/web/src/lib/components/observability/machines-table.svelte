<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import {
        Meter,
        MeterIndicator,
        MeterTrack,
    } from "$lib/components/ui/meter";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        Table,
        TableBody,
        TableCell,
        TableHead,
        TableHeader,
        TableRow,
    } from "$lib/components/ui/table";
    import {
        bandwidth,
        bytes,
        cores,
        machinesUsage,
        machineValue,
        usageLevel,
        usageText,
        type MachineData,
        type UsageAmount,
    } from "$lib/observability";
    import { usageDisplay } from "$lib/observability/usage-display.svelte";
    import { parseAsString, useQueryState } from "nuqs-svelte";

    let {
        machines,
        loading,
        machine = $bindable(""),
        hoveredMachine = $bindable(""),
    }: {
        machines: MachineData[];
        loading: boolean;
        machine?: string;
        hoveredMachine?: string;
    } = $props();

    function toRow(item: MachineData) {
        return {
            item,
            label: `${item.cluster.name} / ${item.name}`,
            ...machinesUsage([item]),
            networkIn: machineValue(item, "networkIn"),
            networkOut: machineValue(item, "networkOut"),
            diskRead: machineValue(item, "diskRead"),
            diskWrite: machineValue(item, "diskWrite"),
        };
    }

    type Row = ReturnType<typeof toRow>;

    function usageValue(usage: UsageAmount) {
        return usageDisplay.current === "percent"
            ? usage.percent
            : usage.used;
    }

    const columns: {
        id: string;
        label: string;
        value: (row: Row) => string | number | null;
    }[] = [
        { id: "name", label: "Machine", value: (row) => row.label },
        {
            id: "cpu",
            label: "CPU",
            value: (row) => usageValue(row.cpu),
        },
        {
            id: "memory",
            label: "Memory",
            value: (row) => usageValue(row.memory),
        },
        {
            id: "disk",
            label: "Disk",
            value: (row) => usageValue(row.disk),
        },
        {
            id: "networkIn",
            label: "Network ↓",
            value: (row) => row.networkIn,
        },
        {
            id: "networkOut",
            label: "Network ↑",
            value: (row) => row.networkOut,
        },
        {
            id: "diskRead",
            label: "Disk read",
            value: (row) => row.diskRead,
        },
        {
            id: "diskWrite",
            label: "Disk write",
            value: (row) => row.diskWrite,
        },
    ];

    // "cpu" sorts ascending and "-cpu" descending, so a reload or shared link keeps the order.
    const sort = useQueryState(
        "machinesSort",
        parseAsString.withDefault("").withOptions({
            shallow: true,
            scroll: false,
        }),
    );

    const descending = $derived(sort.current.startsWith("-"));

    const sortId = $derived(sort.current.replace(/^-/u, ""));

    const rows = $derived.by(() => {
        const items = machines.map(toRow);
        const column = columns.find(({ id }) => id === sortId);

        if (!column) return items;

        return items.toSorted((a, b) => {
            const first = column.value(a);
            const second = column.value(b);

            if (first === second) return 0;

            // Machines without a sample stay last in either direction.
            if (first === null) return 1;

            if (second === null) return -1;

            return first < second === descending ? 1 : -1;
        });
    });

    /** Busiest first is what you sort for, so a column goes descending, ascending, then off. */
    function toggleSort(id: string) {
        if (sortId !== id) sort.current = `-${id}`;
        else sort.current = descending ? id : "";
    }

    const levelColors = {
        normal: "bg-primary",
        warning: "bg-warning",
        critical: "bg-destructive",
    };
</script>

{#snippet usage(
    name: string,
    kind: "cpu" | "memory" | "disk",
    amount: UsageAmount,
    format: (value: number | null) => string,
)}
    <div class="min-w-28 space-y-1.5">
        <span class="block tabular-nums">
            {usageText(amount, format, usageDisplay.current)}
        </span>
        {#if amount.percent !== null}
            <Meter
                value={Math.min(amount.percent, 100)}
                aria-label={name}
            >
                <MeterTrack class="h-1.5 rounded-full">
                    <MeterIndicator
                        class={levelColors[
                            usageLevel(kind, amount.percent)
                        ]}
                    />
                </MeterTrack>
            </Meter>
        {/if}
    </div>
{/snippet}

<Frame class="min-w-0">
    <FrameHeader><FrameTitle>Machines</FrameTitle></FrameHeader>
    <FramePanel class="min-w-0 p-4">
        <Skeleton {loading} label="Loading machines">
            <Table>
                <TableHeader>
                    <TableRow>
                        {#each columns as column, index (column.id)}
                            <TableHead
                                class={index ? "text-center" : ""}
                                aria-sort={sortId === column.id
                                    ? descending
                                        ? "descending"
                                        : "ascending"
                                    : "none"}
                            >
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    class="h-8 px-2 text-sm font-medium text-muted-foreground hover:text-foreground {index
                                        ? ''
                                        : '-ml-2'}"
                                    onclick={() =>
                                        toggleSort(column.id)}
                                >
                                    {column.label}
                                    {sortId === column.id
                                        ? descending
                                            ? "↓"
                                            : "↑"
                                        : "↕"}
                                </Button>
                            </TableHead>
                        {/each}
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {#each rows as row (row.item.key)}
                        <TableRow
                            class={[
                                "cursor-pointer",
                                machine === row.item.key &&
                                    "bg-muted",
                            ]}
                            onclick={() =>
                                (machine =
                                    machine === row.item.key
                                        ? ""
                                        : row.item.key)}
                            onpointerenter={() =>
                                (hoveredMachine = row.item.key)}
                            onpointerleave={() =>
                                (hoveredMachine = "")}
                        >
                            <TableCell>
                                <!-- The row handles the click; this makes it reachable by keyboard. -->
                                <button
                                    type="button"
                                    class="flex items-center gap-2 text-left"
                                    aria-pressed={machine ===
                                        row.item.key}
                                    onfocus={() =>
                                        (hoveredMachine =
                                            row.item.key)}
                                    onblur={() =>
                                        (hoveredMachine = "")}
                                >
                                    <span
                                        class="size-2 shrink-0 rounded-full"
                                        style:background={row.item
                                            .color}
                                    ></span>
                                    {row.label}
                                </button>
                            </TableCell>
                            <TableCell>
                                {@render usage(
                                    `${row.label} CPU`,
                                    "cpu",
                                    row.cpu,
                                    cores,
                                )}
                            </TableCell>
                            <TableCell>
                                {@render usage(
                                    `${row.label} memory`,
                                    "memory",
                                    row.memory,
                                    bytes,
                                )}
                            </TableCell>
                            <TableCell>
                                {@render usage(
                                    `${row.label} disk`,
                                    "disk",
                                    row.disk,
                                    bytes,
                                )}
                            </TableCell>
                            {#each [row.networkIn, row.networkOut, row.diskRead, row.diskWrite] as rate, index (index)}
                                <TableCell
                                    class="text-center tabular-nums"
                                >
                                    {bandwidth(rate)}
                                </TableCell>
                            {/each}
                        </TableRow>
                    {:else}
                        <TableRow>
                            <TableCell
                                colspan={columns.length}
                                class="text-center text-muted-foreground"
                            >
                                No machines are reporting.
                            </TableCell>
                        </TableRow>
                    {/each}
                </TableBody>
            </Table>
        </Skeleton>
    </FramePanel>
</Frame>
