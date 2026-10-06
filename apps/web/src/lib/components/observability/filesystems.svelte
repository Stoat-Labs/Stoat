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
        percent,
        type filesystemRows,
    } from "$lib/observability";
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
</script>

<Frame class="min-w-0">
    <FrameHeader><FrameTitle>Filesystems</FrameTitle></FrameHeader>
    <FramePanel class="min-w-0 p-4">
        <Skeleton {loading} loading-label="Loading filesystems">
            <MetricChart
                series={rows}
                {start}
                {end}
                max={100}
                bind:hoveredMachine
            />
            <Table class="mt-4">
                <TableHeader>
                    <TableRow>
                        <TableHead>
                            Machine / mount
                        </TableHead><TableHead>
                            Device
                        </TableHead><TableHead>
                            Type
                        </TableHead><TableHead class="text-right">
                            Used / capacity
                        </TableHead><TableHead class="text-right">
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
                            <TableCell class="font-mono text-xs">
                                {row.device}
                            </TableCell>
                            <TableCell>{row.fstype}</TableCell>
                            <TableCell
                                class="text-right tabular-nums"
                            >
                                {bytes(row.used)} / {bytes(row.total)}
                            </TableCell>
                            <TableCell
                                class="text-right tabular-nums"
                            >
                                <span
                                    class:text-warning-foreground={row.percent !==
                                        null &&
                                        row.percent >= 85 &&
                                        row.percent < 95}
                                    class:text-destructive-foreground={row.percent !==
                                        null && row.percent >= 95}
                                >
                                    {percent(row.percent)}
                                </span>
                            </TableCell>
                        </TableRow>
                    {:else}
                        <TableRow>
                            <TableCell
                                colspan={5}
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
