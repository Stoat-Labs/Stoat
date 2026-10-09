<script lang="ts">
    import Filesystems from "./filesystems.svelte";
    import MetricChart from "./metric-chart.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import {
        bandwidth,
        bytes,
        chartSeries,
        chartSeriesRatio,
        filesystemRows,
        machineValue,
        percent,
        sumMachines,
        type MachineData,
    } from "$lib/observability";
    import type { MachineMetricName } from "@stoat/api/observability";

    let {
        machines,
        visibleMachines,
        start,
        end,
        filesystemsLoading,
        machine = $bindable(""),
    }: {
        machines: MachineData[];
        visibleMachines: MachineData[];
        start: number;
        end: number;
        filesystemsLoading: boolean;
        machine?: string;
    } = $props();

    let hoveredMachine = $state("");

    const memory = $derived(sumMachines(visibleMachines, "memory"));

    const memoryTotal = $derived(
        sumMachines(visibleMachines, "memoryTotal"),
    );

    const disk = $derived(sumMachines(visibleMachines, "disk"));

    const diskTotal = $derived(
        sumMachines(visibleMachines, "diskTotal"),
    );

    const cores = $derived(sumMachines(visibleMachines, "cores"));

    const filesystems = $derived(filesystemRows(visibleMachines));

    const reporting = $derived(
        visibleMachines.filter(
            (item) => machineValue(item, "cpu") !== null,
        ).length,
    );

    const pressure = $derived([
        ...visibleMachines.flatMap((item) => {
            const used = machineValue(item, "memory");
            const capacity = machineValue(item, "memoryTotal");

            const ratio =
                used !== null && capacity
                    ? (100 * used) / capacity
                    : null;

            return ratio !== null && ratio >= 90
                ? [
                      {
                          key: `${item.key}:memory`,
                          text: `${item.cluster.name} / ${item.name}: memory ${percent(ratio)} used`,
                          critical: ratio >= 97,
                      },
                  ]
                : [];
        }),
        ...filesystems.flatMap((row) =>
            row.percent !== null && row.percent >= 85
                ? [
                      {
                          key: row.key,
                          text: `${row.label}: disk ${percent(row.percent)} full`,
                          critical: row.percent >= 95,
                      },
                  ]
                : [],
        ),
    ]);

    /** Receive/send and read/write share a chart; suffix each machine's label with its direction. */
    function directions(
        first: [MachineMetricName, string],
        second: [MachineMetricName, string],
    ) {
        return [first, second].flatMap(([name, suffix]) =>
            chartSeries(visibleMachines, name).map((item) => ({
                ...item,
                label: `${item.label} ${suffix}`,
            })),
        );
    }

    function dim(key: string) {
        return hoveredMachine && hoveredMachine !== key ? 0.4 : 1;
    }
</script>

{#snippet legend()}
    <div class="mt-3 flex flex-wrap gap-x-4 gap-y-2">
        {#each visibleMachines as item (item.key)}
            <span
                class="flex items-center gap-2 text-xs"
                style:opacity={dim(item.key)}
            >
                <span
                    class="size-2 rounded-full"
                    style:background={item.color}
                ></span>
                {item.cluster.name} / {item.name}
            </span>
        {/each}
    </div>
{/snippet}

{#if pressure.length}
    <Alert
        variant={pressure.some((item) => item.critical)
            ? "error"
            : "warning"}
    >
        <AlertDescription>
            <span class="font-medium">Resource pressure:</span>
            {pressure.map((item) => item.text).join(" · ")}
        </AlertDescription>
    </Alert>
{/if}

<Frame>
    <FrameHeader
        class="flex-row flex-wrap items-center justify-between gap-2"
    >
        <FrameTitle>CPU per machine</FrameTitle>
        <span class="text-xs text-muted-foreground tabular-nums">
            <span class="font-medium text-foreground">
                {percent(sumMachines(visibleMachines, "cpu"))}
            </span>
            of {percent(
                cores === null ? null : cores * 100,
            )}{reporting < visibleMachines.length
                ? ` · ${reporting} / ${visibleMachines.length} reporting`
                : ""}
        </span>
    </FrameHeader>
    <FramePanel class="min-w-0 p-4">
        <MetricChart
            series={chartSeries(visibleMachines, "cpu")}
            {start}
            {end}
            bind:hoveredMachine
        />
        <div class="mt-3 flex flex-wrap gap-2">
            {#each machines as item (item.key)}
                <Button
                    variant={machine === item.key
                        ? "secondary"
                        : "ghost"}
                    size="sm"
                    class="gap-2 text-xs"
                    style={`opacity: ${dim(item.key)}`}
                    onpointerenter={() => (hoveredMachine = item.key)}
                    onpointerleave={() => (hoveredMachine = "")}
                    onfocus={() => (hoveredMachine = item.key)}
                    onblur={() => (hoveredMachine = "")}
                    aria-pressed={machine === item.key}
                    onclick={() =>
                        (machine =
                            machine === item.key ? "" : item.key)}
                >
                    <span
                        class="size-2 rounded-full"
                        style:background={item.color}
                    ></span>
                    {item.cluster.name} / {item.name}
                    <span class="font-semibold tabular-nums">
                        {percent(machineValue(item, "cpu"))}
                    </span>
                </Button>
            {/each}
        </div>
    </FramePanel>
</Frame>

<div class="grid gap-4 lg:grid-cols-2">
    <Frame class="min-w-0">
        <FrameHeader
            class="flex-row flex-wrap items-center justify-between gap-2"
        >
            <FrameTitle>Memory by machine</FrameTitle>
            <span class="text-xs text-muted-foreground tabular-nums">
                <span class="font-medium text-foreground">
                    {bytes(memory)}
                </span>
                of {bytes(memoryTotal)}
            </span>
        </FrameHeader>
        <FramePanel class="min-w-0 p-4">
            <MetricChart
                series={chartSeries(visibleMachines, "memory")}
                {start}
                {end}
                unit="bytes"
                bind:hoveredMachine
            />
            {@render legend()}
        </FramePanel>
    </Frame>
    <Frame class="min-w-0">
        <FrameHeader
            class="flex-row flex-wrap items-center justify-between gap-2"
        >
            <FrameTitle>Disk usage · all filesystems</FrameTitle>
            <span class="text-xs text-muted-foreground tabular-nums">
                <span class="font-medium text-foreground">
                    {disk !== null && diskTotal
                        ? percent((100 * disk) / diskTotal)
                        : "—"}
                </span>
                · {bytes(disk)} of {bytes(diskTotal)}
            </span>
        </FrameHeader>
        <FramePanel class="min-w-0 p-4">
            <MetricChart
                series={chartSeriesRatio(
                    visibleMachines,
                    "disk",
                    "diskTotal",
                )}
                {start}
                {end}
                max={100}
                bind:hoveredMachine
            />
            {@render legend()}
        </FramePanel>
    </Frame>
    <Frame class="min-w-0">
        <FrameHeader
            class="flex-row flex-wrap items-center justify-between gap-2"
        >
            <FrameTitle>Network · receive / send</FrameTitle>
            <span class="text-xs text-muted-foreground tabular-nums">
                ↓ <span class="font-medium text-foreground">
                    {bandwidth(
                        sumMachines(visibleMachines, "networkIn"),
                    )}
                </span>
                · ↑
                <span class="font-medium text-foreground">
                    {bandwidth(
                        sumMachines(visibleMachines, "networkOut"),
                    )}
                </span>
            </span>
        </FrameHeader>
        <FramePanel class="min-w-0 p-4">
            <MetricChart
                series={directions(
                    ["networkIn", "receive"],
                    ["networkOut", "send"],
                )}
                {start}
                {end}
                unit="rate"
                bind:hoveredMachine
            />
            <p class="mt-2 text-xs text-muted-foreground">
                Solid: receive · dashed: send · bits per second
            </p>
        </FramePanel>
    </Frame>
    <Frame class="min-w-0">
        <FrameHeader
            class="flex-row flex-wrap items-center justify-between gap-2"
        >
            <FrameTitle>Disk I/O · read / write</FrameTitle>
            <span class="text-xs text-muted-foreground tabular-nums">
                R <span class="font-medium text-foreground">
                    {bandwidth(
                        sumMachines(visibleMachines, "diskRead"),
                    )}
                </span>
                · W
                <span class="font-medium text-foreground">
                    {bandwidth(
                        sumMachines(visibleMachines, "diskWrite"),
                    )}
                </span>
            </span>
        </FrameHeader>
        <FramePanel class="min-w-0 p-4">
            <MetricChart
                series={directions(
                    ["diskRead", "read"],
                    ["diskWrite", "write"],
                )}
                {start}
                {end}
                unit="rate"
                bind:hoveredMachine
            />
            <p class="mt-2 text-xs text-muted-foreground">
                Solid: read · dashed: write · bytes per second
            </p>
        </FramePanel>
    </Frame>
</div>

<Filesystems
    rows={filesystems}
    {start}
    {end}
    loading={filesystemsLoading}
    bind:hoveredMachine
/>
