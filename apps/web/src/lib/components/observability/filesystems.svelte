<script lang="ts">
    import MetricChart from "./metric-chart.svelte";
    import {
        Frame,
        FrameHeader,
        FramePanel,
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
    import {
        bytes,
        usageAmount,
        usageLevel,
        usageText,
        type filesystemRows,
    } from "$lib/observability";
    import { usageDisplay } from "$lib/observability/usage-display.svelte";
    import { Skeleton } from "$lib/components/ui/skeleton";

    let {
        rows,
        start,
        end,
        loading = false,
        hoveredMachine = $bindable(""),
    }: {
        rows: ReturnType<typeof filesystemRows>;
        start: number;
        end: number;
        loading?: boolean;
        hoveredMachine?: string;
    } = $props();

    const showPercent = $derived(usageDisplay.current === "percent");

    const series = $derived(
        showPercent
            ? rows
            : rows.map((row) => ({ ...row, points: row.usedPoints })),
    );
</script>

<Frame class="min-w-0">
    <FrameHeader><FrameTitle>Filesystems</FrameTitle></FrameHeader>
    <FramePanel class="min-w-0 p-4">
        <Skeleton {loading} label="Loading filesystems">
            <MetricChart
                {series}
                {start}
                {end}
                unit={showPercent ? "percent" : "bytes"}
                max={showPercent ? 100 : undefined}
                bind:hoveredMachine
            />
            <Table class="mt-4">
                <TableHeader>
                    <TableRow>
                        <TableHead>
                            Machine / mount
                        </TableHead><TableHead class="text-center">
                            Device
                        </TableHead><TableHead class="text-center">
                            Type
                        </TableHead><TableHead class="text-center">
                            Usage
                        </TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {#each rows as row (row.key)}
                        <TableRow>
                            <TableCell>
                                <span class="flex items-center gap-2">
                                    <span
                                        class="size-2 shrink-0 rounded-full"
                                        style:background={row.color}
                                    ></span>
                                    {row.label}
                                </span>
                            </TableCell>
                            <TableCell
                                class="font-mono text-center text-xs"
                            >
                                {row.device}
                            </TableCell>
                            <TableCell class="text-center">
                                {row.fstype}
                            </TableCell>
                            <TableCell
                                class="text-center tabular-nums"
                            >
                                <span
                                    class:text-warning-foreground={usageLevel(
                                        "disk",
                                        row.percent,
                                    ) === "warning"}
                                    class:text-destructive-foreground={usageLevel(
                                        "disk",
                                        row.percent,
                                    ) === "critical"}
                                >
                                    {usageText(
                                        usageAmount(
                                            row.used,
                                            row.total,
                                        ),
                                        bytes,
                                        usageDisplay.current,
                                    )}
                                </span>
                            </TableCell>
                        </TableRow>
                    {:else}
                        <TableRow>
                            <TableCell
                                colspan={4}
                                class="text-center text-muted-foreground"
                            >
                                No filesystem samples in this range.
                            </TableCell>
                        </TableRow>
                    {/each}
                </TableBody>
            </Table>
            <p class="mt-2 text-xs text-muted-foreground">
                Disk-backed mounts · each filesystem is counted once
                in disk totals, even with multiple mounts.
            </p>
        </Skeleton>
    </FramePanel>
</Frame>
