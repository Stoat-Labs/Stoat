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
        changes: {
            resource: CanvasResource;
            removed: string[];
            pendingDelete: boolean;
        }[];
    } = $props();

    const deletions = $derived(
        changes.filter(({ pendingDelete }) => pendingDelete),
    );

    const isAdmin = $derived(page.data.isOrganizationAdmin === true);

    const removals = $derived(
        changes.flatMap(({ resource, removed, pendingDelete }) =>
            pendingDelete
                ? []
                : removed.map(
                      (service) => `${service} (${resource.name})`,
                  ),
        ),
    );

    const deletedNames = $derived(
        deletions.map(({ resource }) => resource.name).join(", "),
    );

    const confirmTitle = $derived(
        deletions.length
            ? `Deploy and delete ${deletions.length === 1 ? deletedNames : `${deletions.length} resources`}?`
            : `Deploy and remove ${removals.length === 1 ? "a service" : `${removals.length} services`}?`,
    );

    const confirmDescription = $derived(
        [
            deletions.length &&
                `Deleting ${deletedNames} removes their services from the cluster and their deployment history. Buckets have their keys revoked and are deleted if empty. This cannot be undone.`,
            removals.length &&
                `Deploying stops and removes ${removals.join(", ")}, which the Compose file no longer has.`,
            "Volumes stay on the machines.",
        ]
            .filter(Boolean)
            .join(" "),
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

    let discarding = $state(false);

    let discardOpen = $state(false);

    let discardError = $state("");

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

        if (removals.length || deletions.length) confirming = true;
        else void deploy();
    }

    // Resources that drop services go first and finish before the rest start: a service moved to
    // another resource keeps its volume, and two containers must never run on it at once.
    async function deploy(force = false) {
        deploying = true;
        error = "";

        const deploys = changes.filter(
            ({ pendingDelete }) => !pendingDelete,
        );

        const losing = deploys.filter(
            ({ removed }) => removed.length,
        );

        const rest = deploys.filter(({ removed }) => !removed.length);

        try {
            // Deleted first, so their services are gone before anything moved out of them starts.
            for (const { resource } of deletions) {
                const target = { projectId, resourceId: resource.id };

                // A bucket revokes its provider keys in a background job, which then removes it.
                await (
                    resource.type === "bucket"
                        ? client.buckets.remove(target)
                        : client.resources.deleteResource(target)
                ).catch((cause) => {
                    // Its CONFLICTs (still referenced, deploying) are not the Git one handled below.
                    throw new Error(
                        cause instanceof Error
                            ? cause.message
                            : `${resource.name} could not be deleted.`,
                    );
                });
            }

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

    // Every staged resource goes back to its last deploy; one that never deployed is removed.
    async function discard() {
        discarding = true;
        discardError = "";

        try {
            await client.resources.discardChanges({
                projectId,
                resourceIds: changes.map(
                    ({ resource }) => resource.id,
                ),
            });

            discardOpen = false;
            details.current = false;
        } catch (cause) {
            discardError =
                cause instanceof Error
                    ? cause.message
                    : "Discard failed.";
        } finally {
            discarding = false;
            await queryClient.invalidateQueries({
                queryKey: orpc.resources.key(),
            });
        }
    }

    function startDiscard() {
        discardError = "";
        discardOpen = true;
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
            variant="ghost"
            class="text-muted-foreground"
            disabled={deploying || discarding}
            onclick={startDiscard}
        >
            Discard
        </Button>
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
    ondiscard={startDiscard}
/>

<ConfirmDialog
    bind:open={discardOpen}
    title="Discard {changes.length === 1
        ? 'this change'
        : `${changes.length} changes`}?"
    description="Each resource goes back to what it last deployed, staged deletions are undone, and resources that were never deployed are removed. This can't be undone."
    confirmLabel="Discard changes"
    pending={discarding}
    error={discardError}
    onconfirm={() => void discard()}
/>

<ConfirmDialog
    bind:open={confirming}
    title={confirmTitle}
    description={confirmDescription}
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
