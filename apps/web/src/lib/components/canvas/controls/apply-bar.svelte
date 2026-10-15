<script lang="ts">
    import { page } from "$app/state";
    import { ORPCError } from "@orpc/client";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import { Button } from "$lib/components/ui/button";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import { isTerminalDeploymentStatus } from "$lib/deployments/status";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";
    import type { CanvasResource } from "../graph";
    import ChangesDialog from "./changes-dialog.svelte";

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

    // Railway's "Details": the diffs behind the count, in the URL like other canvas dialogs.
    const details = useQueryState(
        "changes",
        parseAsBoolean
            .withDefault(false)
            .withOptions({ shallow: true, scroll: false }),
    );

    let confirming = $state(false);

    let conflicted = $state(false);

    let deploying = $state(false);

    let error = $state("");

    // Only a ready cleanup lets the rest start: a failed or cancelled one may leave a moved
    // service running on the volume its new resource is about to use.
    async function finished(deploymentId: string, name: string) {
        for (;;) {
            const deployment = await client.cluster.getDeployment({
                deploymentId,
            });

            if (deployment.status === "ready") return;

            if (isTerminalDeploymentStatus(deployment.status))
                throw new Error(
                    `${name} was ${deployment.status === "cancelled" ? "cancelled" : "not deployed"}, so the other changes were not deployed.`,
                );

            await new Promise((resolve) => setTimeout(resolve, 1500));
        }
    }

    // Removing services is confirmed first, from the bar or from the details dialog.
    function startDeploy() {
        error = "";

        if (removals.length) confirming = true;
        else void deploy();
    }

    // Resources that drop services go first and finish before the rest start: a service moved to
    // another resource keeps its volume, and two containers must never run on it at once.
    async function deploy(force = false) {
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
                    force,
                });

                if (rest.length) await finished(id, resource.name);
            }

            // Git-backed drafts are committed to their branch by the deploy itself.
            for (const { resource } of rest)
                await client.resources.deploy({
                    projectId,
                    resourceId: resource.id,
                    force,
                });

            confirming = false;
            conflicted = false;
        } catch (cause) {
            if (
                cause instanceof ORPCError &&
                cause.code === "CONFLICT"
            ) {
                confirming = false;
                conflicted = true;

                return;
            }

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
    <Button
        size="sm"
        variant="outline"
        onclick={() => (details.current = true)}
    >
        Details
    </Button>
    {#if isAdmin}
        <Button
            size="sm"
            loading={deploying}
            disabled={deploying}
            onclick={startDeploy}
        >
            Deploy
        </Button>
    {:else}
        <span class="text-muted-foreground">
            An admin can deploy these.
        </span>
    {/if}
</div>

<ChangesDialog
    bind:open={details.current}
    {projectId}
    {changes}
    canDeploy={isAdmin}
    {deploying}
    ondeploy={() => {
        details.current = false;
        startDeploy();
    }}
/>

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

<ConfirmDialog
    bind:open={conflicted}
    title="Git branch changed"
    description="New commits changed a Compose file or its directory since these changes were saved. Deploying anyway commits them on top of the new head."
    confirmLabel="Deploy anyway"
    pending={deploying}
    onconfirm={() => void deploy(true)}
/>
