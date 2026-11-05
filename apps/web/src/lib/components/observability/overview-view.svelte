<script lang="ts">
    import Filesystems from "./filesystems.svelte";
    import MachinesTable from "./machines-table.svelte";
    import MetricChart from "./metric-chart.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
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
        cores,
        filesystemRows,
        machinesUsage,
        machineValue,
        percent,
        scaleSeries,
        sumMachines,
        usageLevel,
        usageText,
        type MachineData,
    } from "$lib/observability";
    import { usageDisplay } from "$lib/observability/usage-display.svelte";
    import type { MachineMetricName } from "@stoat/api/observability";

    let {
        machines,
        visibleMachines,
        start,
        end,
        filesystemsLoading,
        metricPending,
        machine = $bindable(""),
    }: {
        machines: MachineData[];
        visibleMachines: MachineData[];
        start: number;
        end: number;
        filesystemsLoading: boolean;
        metricPending: (names: MachineMetricName[]) => boolean;
        machine?: string;
    } = $props();

    let hoveredMachine = $state("");

    const usage = $derived(machinesUsage(visibleMachines));

    const showPercent = $derived(usageDisplay.current === "percent");

    // With one machine there is nothing to tell apart, so its charts can fill and drop the machine legend.
    const single = $derived(visibleMachines.length === 1);

    const filesystems = $derived(filesystemRows(visibleMachines));

    const reporting = $derived(
        visibleMachines.filter(
            (item) => machineValue(item, "cpu") !== null,
        ).length,
    );

    const pressure = $derived([
        ...visibleMachines.flatMap((item) => {
            const ratio = machinesUsage([item]).memory.percent;
            const level = usageLevel("memory", ratio);

            return level === "normal"
                ? []
                : [
                      {
                          key: `${item.key}:memory`,
                          text: `${item.cluster.name} / ${item.name}: memory ${percent(ratio)} used`,
                          critical: level === "critical",
                      },
                  ];
        }),
        ...filesystems.flatMap((row) => {
            const level = usageLevel("disk", row.percent);

            return level === "normal"
                ? []
                : [
                      {
                          key: row.key,
                          text: `${row.label}: disk ${percent(row.percent)} full`,
                          critical: level === "critical",
                      },
                  ];
        }),
    ]);

    /**
     * Receive/send and read/write share a chart. Several machines keep their colors, so direction
     * is the dash; one machine has its color free to show direction instead.
     */
    function directions(
        first: [MachineMetricName, string],
        second: [MachineMetricName, string],
    ) {
        return [first, second].flatMap(([name, suffix], index) =>
            chartSeries(visibleMachines, name).map((item) =>
                single
                    ? {
                          ...item,
                          label: suffix,
                          color: `var(--chart-${index + 1})`,
                          dashed: false,
                      }
                    : { ...item, label: `${item.label} ${suffix}` },
            ),
        );
    }

    function dim(key: string) {
        return hoveredMachine && hoveredMachine !== key ? 0.4 : 1;
    }
</script>

{#snippet legend()}
    {#if !single}
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
    {/if}
{/snippet}

{#snippet directionLegend(first: string, second: string)}
    {#if single}
        <div class="mt-3 flex flex-wrap gap-x-4 gap-y-2">
            {#each [first, second] as label, index (label)}
                <span class="flex items-center gap-2 text-xs">
                    <span
                        class="size-2 rounded-full"
                        style:background={`var(--chart-${index + 1})`}
                    ></span>
                    {label}
                </span>
            {/each}
        </div>
    {:else}
        <p class="mt-2 text-xs text-muted-foreground">
            Solid: {first.toLowerCase()} · dashed: {second.toLowerCase()}
        </p>
    {/if}
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

<MachinesTable
    {machines}
    loading={metricPending([
        "cpu",
        "cores",
        "memory",
        "memoryTotal",
        "disk",
        "diskTotal",
        "networkIn",
        "networkOut",
        "diskRead",
        "diskWrite",
    ])}
    bind:machine
    bind:hoveredMachine
/>

<Frame>
    <FrameHeader
        class="flex-row flex-wrap items-center justify-between gap-2"
    >
        <FrameTitle>CPU per machine</FrameTitle>
        <span class="text-xs text-muted-foreground tabular-nums">
            <span class="font-medium text-foreground">
                {usageText(usage.cpu, cores, usageDisplay.current)}
            </span>
            {reporting < visibleMachines.length
                ? ` · ${reporting} / ${visibleMachines.length} reporting`
                : ""}
        </span>
    </FrameHeader>
    <FramePanel class="min-w-0 p-4">
        <MetricChart
            series={scaleSeries(
                showPercent
                    ? chartSeriesRatio(
                          visibleMachines,
                          "cpu",
                          "cores",
                      )
                    : chartSeries(visibleMachines, "cpu"),
                0.01,
            )}
            loading={metricPending(["cpu", "cores"])}
            {start}
            {end}
            unit={showPercent ? "percent" : "cores"}
            max={showPercent ? 100 : undefined}
            fill={single}
            bind:hoveredMachine
        />
        {@render legend()}
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
                    {usageText(
                        usage.memory,
                        bytes,
                        usageDisplay.current,
                    )}
                </span>
            </span>
        </FrameHeader>
        <FramePanel class="min-w-0 p-4">
            <MetricChart
                series={showPercent
                    ? chartSeriesRatio(
                          visibleMachines,
                          "memory",
                          "memoryTotal",
                      )
                    : chartSeries(visibleMachines, "memory")}
                loading={metricPending(["memory", "memoryTotal"])}
                {start}
                {end}
                unit={showPercent ? "percent" : "bytes"}
                max={showPercent ? 100 : undefined}
                fill={single}
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
                    {usageText(
                        usage.disk,
                        bytes,
                        usageDisplay.current,
                    )}
                </span>
            </span>
        </FrameHeader>
        <FramePanel class="min-w-0 p-4">
            <MetricChart
                series={showPercent
                    ? chartSeriesRatio(
                          visibleMachines,
                          "disk",
                          "diskTotal",
                      )
                    : chartSeries(visibleMachines, "disk")}
                loading={metricPending(["disk", "diskTotal"])}
                {start}
                {end}
                unit={showPercent ? "percent" : "bytes"}
                max={showPercent ? 100 : undefined}
                fill={single}
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
                loading={metricPending(["networkIn", "networkOut"])}
                {start}
                {end}
                unit="rate"
                fill={single}
                bind:hoveredMachine
            />
            {@render directionLegend("Receive", "Send")}
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
                loading={metricPending(["diskRead", "diskWrite"])}
                {start}
                {end}
                unit="rate"
                fill={single}
                bind:hoveredMachine
            />
            {@render directionLegend("Read", "Write")}
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
