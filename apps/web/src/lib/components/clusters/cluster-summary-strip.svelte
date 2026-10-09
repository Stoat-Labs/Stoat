<script lang="ts">
    import CircleAlert from "@lucide/svelte/icons/circle-alert";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import Network from "@lucide/svelte/icons/network";
    import Server from "@lucide/svelte/icons/server";

    let {
        machineCount,
        linkCount,
        issueCount,
        versionDrift,
    }: {
        machineCount: number;
        linkCount: number;
        issueCount: number;
        versionDrift: boolean;
    } = $props();

    const stats = $derived([
        {
            label: "Machines",
            icon: Server,
            value: String(machineCount),
            hint: "Reported by the cluster",
        },
        {
            label: "Connections",
            icon: Network,
            value: String(linkCount),
            hint: "Measured machine links",
        },
        {
            label: "Issues",
            icon: CircleAlert,
            value: String(issueCount),
            hint: "Reported by diagnostics",
        },
        {
            label: "Versions",
            icon: GitBranch,
            value: versionDrift ? "Drift" : "Aligned",
            hint: "Across cluster machines",
        },
    ]);
</script>

<div
    class="grid overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 xl:grid-cols-4"
>
    {#each stats as stat (stat.label)}
        <div class="bg-card p-4">
            <div
                class="flex items-center gap-2 text-muted-foreground"
            >
                <stat.icon class="size-4" aria-hidden="true" />
                <span class="text-sm">{stat.label}</span>
            </div>
            <p class="mt-3 text-2xl font-semibold">{stat.value}</p>
            <p class="mt-1 text-xs text-muted-foreground">
                {stat.hint}
            </p>
        </div>
    {/each}
</div>
