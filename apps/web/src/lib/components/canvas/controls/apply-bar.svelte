<script lang="ts">
    import { page } from "$app/state";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import { Button } from "$lib/components/ui/button";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import { isTerminalDeploymentStatus } from "$lib/deployments/status";
    import type { CanvasResource } from "../graph";

    let {
        projectId,
        changes,
    }: {
        projectId: string;
        /** Resources with saved changes that are not live, and the running services deploying them removes. */
        changes: { resource: CanvasResource; removed: string[] }[];
    } = $props();

    const isAdmin = $derived(page.data.isOrganizationAdmin === true);

    const removals = $derived(
        changes.flatMap(({ resource, removed }) =>
            removed.map((service) => `${service} (${resource.name})`),
        ),
    );

    let confirming = $state(false);

    let deploying = $state(false);

    let error = $state("");

    async function finished(deploymentId: string) {
        for (;;) {
            const deployment = await client.cluster.getDeployment({
                deploymentId,
            });

            if (isTerminalDeploymentStatus(deployment.status)) return;

            await new Promise((resolve) => setTimeout(resolve, 1500));
        }
    }

    // Resources that drop services go first and finish before the rest start: a service moved to
    // another resource keeps its volume, and two containers must never run on it at once.
    async function deploy() {
        deploying = true;
        error = "";

        const losing = changes.filter(
            ({ removed }) => removed.length,
        );

        const rest = changes.filter(({ removed }) => !removed.length);

        try {
            for (const { resource } of losing) {
                const { id } = await client.resources.deploy({
                    projectId,
                    resourceId: resource.id,
                });

                if (rest.length) await finished(id);
            }

            // Git-backed drafts are committed to their branch by the deploy itself.
            for (const { resource } of rest)
                await client.resources.deploy({
                    projectId,
                    resourceId: resource.id,
                });

            confirming = false;
        } catch (cause) {
            error =
                cause instanceof Error
                    ? cause.message
                    : "Deploy failed.";
        } finally {
            deploying = false;
            await queryClient.invalidateQueries({
                queryKey: orpc.resources.listResources.key(),
            });
            await queryClient.invalidateQueries({
                queryKey: orpc.resources.getProjectGraph.key(),
            });
        }
    }
</script>

<!-- Railway's staged-changes bar: what is saved but not live yet, and one button to ship it. -->
<div
    class="flex items-center gap-3 rounded-lg border border-foreground/14 bg-card py-1.5 ps-4 pe-1.5 text-sm shadow-md/10"
    role="status"
>
    <span
        class="text-foreground"
        title={changes
            .map(({ resource }) => resource.name)
            .join(", ")}
    >
        Apply {changes.length}
        {changes.length === 1 ? "change" : "changes"}
    </span>
    {#if error && !confirming}
        <span
            class="max-w-60 truncate text-destructive-foreground"
            title={error}
        >
            {error}
        </span>
    {/if}
    {#if isAdmin}
        <Button
            size="sm"
            loading={deploying}
            disabled={deploying}
            onclick={() => {
                error = "";

                if (removals.length) confirming = true;
                else void deploy();
            }}
        >
            Deploy
        </Button>
    {:else}
        <span class="text-muted-foreground">
            An admin can deploy these.
        </span>
    {/if}
</div>

<ConfirmDialog
    bind:open={confirming}
    title="Deploy and remove {removals.length === 1
        ? 'a service'
        : `${removals.length} services`}?"
    description="Deploying stops and removes {removals.join(
        ', ',
    )}, which the Compose file no longer has. Their volumes stay on the machines."
    confirmLabel="Deploy"
    pending={deploying}
    {error}
    onconfirm={() => void deploy()}
/>
