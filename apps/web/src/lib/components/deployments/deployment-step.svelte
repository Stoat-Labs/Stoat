<script lang="ts">
    import {
        Progress,
        ProgressIndicator,
        ProgressTrack,
    } from "$lib/components/ui/progress";
    import type { DeploymentStep } from "$lib/deployments/steps";
    import ChevronRight from "@lucide/svelte/icons/chevron-right";
    import CornerDownRight from "@lucide/svelte/icons/corner-down-right";
    import Plus from "@lucide/svelte/icons/plus";
    import Server from "@lucide/svelte/icons/server";
    import StepNode from "./step-node.svelte";

    let {
        step,
        now,
        startedAt,
    }: {
        step: DeploymentStep;
        now: number;
        startedAt: number;
    } = $props();

    // Elapsed since the deployment started, e.g. 00:07 or 01:02:07.
    function offset(value: number) {
        const ms = Math.max(0, value - startedAt);

        return new Date(ms)
            .toISOString()
            .slice(ms >= 3_600_000 ? 11 : 14, 19);
    }

    const monitorElapsed = $derived(
        step.monitor
            ? Math.min(
                  step.monitor.seconds,
                  Math.max(0, (now - step.monitor.since) / 1000),
              )
            : 0,
    );

    const monitoring = $derived(
        !!step.monitor &&
            step.state === "active" &&
            step.history.at(-1) === "monitoring",
    );

    function megabytes(bytes: number) {
        return (bytes / 1_000_000).toFixed(
            bytes >= 10_000_000 ? 0 : 1,
        );
    }

    const stateLabel = $derived(
        step.state === "active"
            ? "In progress:"
            : step.state === "error"
              ? "Failed:"
              : step.state === "stopped"
                ? "Stopped:"
                : "Done:",
    );

    const tone = $derived(
        step.state === "error"
            ? "text-destructive-foreground"
            : step.state === "active"
              ? "text-info-foreground"
              : step.state === "stopped"
                ? "text-muted-foreground"
                : "text-foreground",
    );
</script>

{#snippet machine(name: string)}
    <span
        class="ml-1 mr-2.5 inline-flex items-center gap-1 align-middle text-muted-foreground"
    >
        <Server class="size-3" aria-hidden="true" />
        {name}
    </span>
{/snippet}

{#snippet meter(label: string, value: number, max: number)}
    <Progress {value} {max} aria-label={label} class="w-40">
        <ProgressTrack class="h-1">
            <ProgressIndicator class="bg-info-foreground" />
        </ProgressTrack>
    </Progress>
{/snippet}

<li class="grid grid-cols-[5ch_1rem_minmax(0,1fr)] gap-x-3">
    <time
        class="text-muted-foreground tabular-nums"
        datetime={new Date(step.time).toISOString()}
    >
        {offset(step.time)}
    </time>
    <span class="flex h-5 items-center justify-center">
        <StepNode state={step.state} />
    </span>
    <div class="min-w-0 wrap-anywhere">
        <span class="sr-only">{stateLabel}</span>
        {#if step.kind === "note"}
            <p
                class:text-destructive-foreground={step.state ===
                    "error"}
            >
                {step.title}
                {#if step.detail}<span
                        class="ml-1.5 text-muted-foreground"
                    >
                        {step.detail}
                    </span>{/if}
            </p>
        {:else if step.kind === "plan"}
            <p class="text-muted-foreground">Plan</p>
            {#each step.ops as op, opIndex (opIndex)}
                <p class="flex items-baseline gap-1.5">
                    <Plus
                        class="size-3 shrink-0 translate-y-0.5 text-success-foreground"
                        aria-hidden="true"
                    />
                    <span class="min-w-0">
                        {op.title}
                        {#each op.detail ? op.detail.split(" · ") : [] as part, partIndex (partIndex)}<span
                                class="ml-2 text-muted-foreground"
                            >
                                {part}
                            </span>{/each}
                    </span>
                </p>
            {:else}
                <p class="text-muted-foreground">Nothing to change</p>
            {/each}
        {:else if step.kind === "pull"}
            <p class:text-muted-foreground={step.state === "stopped"}>
                {step.state === "done"
                    ? "Pulled"
                    : step.state === "stopped"
                      ? "Pull interrupted:"
                      : step.state === "error"
                        ? "Pull failed:"
                        : "Pulling"}
                {step.title}
                {#if step.machine}{@render machine(step.machine)}{/if}
                {#if step.state === "stopped" && step.pull?.percent}<span
                        class="text-muted-foreground tabular-nums"
                    >
                        stopped at {step.pull.percent}%
                    </span>{/if}
            </p>
            {#if step.state === "active"}
                <div class="flex items-center gap-2">
                    {@render meter(
                        "Image pull",
                        step.pull?.percent ?? 0,
                        100,
                    )}
                    <span class="text-info-foreground tabular-nums">
                        {step.pull?.percent ?? 0}%
                    </span>
                    {#if step.pull?.total}<span
                            class="hidden text-muted-foreground tabular-nums sm:inline"
                        >
                            {megabytes(step.pull.current)}/{megabytes(
                                step.pull.total,
                            )} MB
                        </span>{/if}
                </div>
            {/if}
        {:else}
            <p class="flex flex-wrap items-center gap-x-1.5">
                {#if step.label}<span class="text-muted-foreground">
                        {step.label}
                    </span>{/if}
                <span>{step.title}</span>
                {#if step.machine}{@render machine(step.machine)}{/if}
                <span
                    class="inline-flex flex-wrap items-center gap-1"
                >
                    {#each step.history as entry, entryIndex (entryIndex)}
                        {@const current =
                            entryIndex === step.history.length - 1}
                        {#if entryIndex}<ChevronRight
                                class="size-3 text-muted-foreground/60"
                                aria-hidden="true"
                            />{/if}
                        <span
                            class="whitespace-nowrap {current
                                ? tone
                                : 'text-muted-foreground'}"
                        >
                            {entry}
                        </span>
                    {/each}
                </span>
            </p>
            {#if monitoring && step.monitor}
                <div class="flex items-center gap-2">
                    {@render meter(
                        "Monitoring period",
                        monitorElapsed,
                        step.monitor.seconds,
                    )}
                    <span class="text-info-foreground tabular-nums">
                        {Math.floor(monitorElapsed)}/{step.monitor
                            .seconds}s
                    </span>
                </div>
            {/if}
        {/if}
        {#if step.kind !== "note" && step.state === "error" && step.detail}
            <p
                class="flex items-baseline gap-1.5 text-destructive-foreground"
            >
                <CornerDownRight
                    class="size-3 shrink-0 translate-y-0.5 text-muted-foreground"
                    aria-hidden="true"
                />
                <span class="min-w-0">{step.detail}</span>
            </p>
        {/if}
    </div>
</li>
