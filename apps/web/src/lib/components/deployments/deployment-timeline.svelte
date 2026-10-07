<script lang="ts">
    import type { DeploymentStep as Step } from "$lib/deployments/steps";
    import { formatDurationMs } from "$lib/format";
    import DeploymentStep from "./deployment-step.svelte";
    import StepNode from "./step-node.svelte";

    let {
        steps,
        now,
        startedAt,
        active,
        retrying,
        status,
        name,
        error,
        durationMs,
        outcomeAt,
    }: {
        steps: Step[];
        now: number;
        startedAt: number;
        active: boolean;
        retrying: boolean;
        status: string;
        name: string;
        error: string | null;
        durationMs: number;
        /** When the deployment settled or last retried, in epoch milliseconds. */
        outcomeAt: number;
    } = $props();

    // Elapsed since the deployment started, e.g. 00:07 or 01:02:07.
    function offset(value: number) {
        const ms = Math.max(0, value - startedAt);

        return new Date(ms)
            .toISOString()
            .slice(ms >= 3_600_000 ? 11 : 14, 19);
    }

    const showOutcome = $derived(retrying || !active);

    const outcomeState = $derived(
        retrying
            ? "stopped"
            : status === "ready"
              ? "done"
              : status === "failed"
                ? "error"
                : "cancelled",
    );
</script>

<ol>
    {#each steps as step (step.key)}
        <DeploymentStep {step} {now} {startedAt} />
    {/each}
</ol>
{#if active && !retrying}
    <p
        class="ml-[calc(5ch+1.75rem)] flex h-5 items-center"
        aria-hidden="true"
    >
        <span
            class="h-3.5 w-1.5 rounded-[1px] bg-info-foreground motion-safe:animate-pulse"
        ></span>
    </p>
{/if}
{#if showOutcome}
    <p
        class="grid grid-cols-[5ch_1rem_minmax(0,1fr)] gap-x-3"
        role="status"
    >
        <time
            class="text-muted-foreground tabular-nums"
            datetime={new Date(outcomeAt).toISOString()}
        >
            {offset(outcomeAt)}
        </time>
        <span class="flex h-5 items-center justify-center">
            <StepNode state={outcomeState} {retrying} />
        </span>
        <span
            class="min-w-0 wrap-anywhere {retrying
                ? 'text-warning-foreground'
                : status === 'ready'
                  ? 'text-success-foreground'
                  : status === 'failed'
                    ? 'text-destructive-foreground'
                    : 'text-muted-foreground'}"
        >
            {#if retrying}
                Retrying{#if error}<span
                        class="ml-1.5 text-muted-foreground"
                    >
                        {error}
                    </span>{/if}
            {:else if status === "ready"}
                {name === "DeployResource" ? "Deployed" : "Done"} in {formatDurationMs(
                    durationMs,
                )}
            {:else if status === "failed"}
                Failed after {formatDurationMs(
                    durationMs,
                )}{#if error && !steps.some((step) => step.state === "error")}<span
                        class="block text-muted-foreground"
                    >
                        {error}
                    </span>{/if}
            {:else}
                Cancelled after {formatDurationMs(durationMs)}
            {/if}
        </span>
    </p>
{/if}
