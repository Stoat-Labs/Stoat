<script lang="ts">
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import type { PanelTab } from "./controls/canvas-context-menu.svelte";
    import {
        configNodeId,
        parseNodeId,
        volumeNodeId,
        type CanvasGraph,
        type CanvasResource,
    } from "./graph";

    let {
        clusterId,
        projectId,
        resources,
        graph,
        selected,
        onclose,
        onopen,
        onerror,
    }: {
        clusterId: string;
        projectId: string;
        resources: CanvasResource[];
        graph: CanvasGraph;
        /** The selected node, closed when it is deleted. */
        selected: string | null;
        onclose: () => void;
        onopen: (nodeId: string, tab: PanelTab) => void;
        /** Failures of actions that have no dialog of their own. */
        onerror: (message: string) => void;
    } = $props();

    async function refreshGraph() {
        await Promise.all([
            queryClient.invalidateQueries({
                queryKey: orpc.resources.getProjectGraph.key(),
            }),
            queryClient.invalidateQueries({
                queryKey: orpc.resources.listResources.key(),
            }),
        ]);
    }

    // A volume nobody mounts leaves the Compose draft; confirmed in an alert dialog first.
    let pendingVolumeDelete = $state<{
        resource: CanvasResource;
        volume: string;
    }>();

    let deletingVolume = $state(false);

    let volumeDeleteError = $state("");

    // A config leaves the Compose draft; confirmed in an alert dialog first, like a volume.
    let pendingConfigDelete = $state<{
        resource: CanvasResource;
        config: string;
    }>();

    let deletingConfig = $state(false);

    let configDeleteError = $state("");

    // Railway's "Redeploy": recreates the containers from the live config, even when nothing changed.
    let pendingRedeploy = $state<CanvasResource>();

    let redeploying = $state(false);

    let redeployError = $state("");

    let pendingStop = $state<CanvasResource>();

    let stopping = $state(false);

    let stopError = $state("");

    export function askRemoveVolume(nodeId: string) {
        const { resourceId, volume } = parseNodeId(nodeId);

        const resource = resources.find(
            (item) => item.id === resourceId,
        );

        if (!resource || !volume) return;

        pendingVolumeDelete = { resource, volume };
        volumeDeleteError = "";
    }

    export function askRemoveConfig(nodeId: string) {
        const { resourceId, config } = parseNodeId(nodeId);

        const resource = resources.find(
            (item) => item.id === resourceId,
        );

        if (!resource || !config) return;

        pendingConfigDelete = { resource, config };
        configDeleteError = "";
    }

    export function askRedeploy(resourceId: string) {
        pendingRedeploy = resources.find(
            (resource) => resource.id === resourceId,
        );
        redeployError = "";
    }

    export function askStop(resourceId: string) {
        pendingStop = resources.find(
            (resource) => resource.id === resourceId,
        );
        stopError = "";
    }

    // Starting needs no confirmation; a failure goes to the canvas notice.
    export async function start(resourceId: string) {
        try {
            await setRunning(resourceId, true);
        } catch (error) {
            onerror(
                error instanceof Error
                    ? error.message
                    : "The resource could not be started.",
            );
        }
    }

    export async function disconnectVolume(nodeId: string) {
        const { resourceId, volume = "" } = parseNodeId(nodeId);

        const services =
            graph
                .find((entry) => entry.id === resourceId)
                ?.volumes.find((item) => item.name === volume)
                ?.services ?? [];

        try {
            for (const service of services)
                await client.resources.detachVolume({
                    projectId,
                    resourceId,
                    volume,
                    service,
                });
        } catch (error) {
            onerror(
                error instanceof Error
                    ? error.message
                    : "The volume could not be disconnected.",
            );
        }

        await refreshGraph();
    }

    export async function disconnectConfig(nodeId: string) {
        const { resourceId, config = "" } = parseNodeId(nodeId);

        const services =
            graph
                .find((entry) => entry.id === resourceId)
                ?.configs.find((item) => item.name === config)
                ?.services ?? [];

        try {
            for (const service of services)
                await client.resources.detachConfig({
                    projectId,
                    resourceId,
                    config,
                    service,
                });
        } catch (error) {
            onerror(
                error instanceof Error
                    ? error.message
                    : "The config could not be disconnected.",
            );
        }

        await refreshGraph();
    }

    async function deleteVolume() {
        if (!pendingVolumeDelete) return;

        const { resource, volume } = pendingVolumeDelete;

        deletingVolume = true;
        volumeDeleteError = "";

        try {
            await client.resources.deleteVolume({
                projectId,
                resourceId: resource.id,
                volume,
            });

            if (selected === volumeNodeId(resource.id, volume))
                onclose();

            pendingVolumeDelete = undefined;
            await refreshGraph();
        } catch (error) {
            volumeDeleteError =
                error instanceof Error
                    ? error.message
                    : "The volume could not be deleted.";
        } finally {
            deletingVolume = false;
        }
    }

    async function deleteConfig() {
        if (!pendingConfigDelete) return;

        const { resource, config } = pendingConfigDelete;

        deletingConfig = true;
        configDeleteError = "";

        try {
            await client.resources.deleteConfig({
                projectId,
                resourceId: resource.id,
                config,
            });

            if (selected === configNodeId(resource.id, config))
                onclose();

            pendingConfigDelete = undefined;
            await refreshGraph();
        } catch (error) {
            configDeleteError =
                error instanceof Error
                    ? error.message
                    : "The config could not be deleted.";
        } finally {
            deletingConfig = false;
        }
    }

    async function redeployResource() {
        if (!pendingRedeploy) return;

        const resourceId = pendingRedeploy.id;

        redeploying = true;
        redeployError = "";

        try {
            await client.resources.deploy({
                projectId,
                resourceId,
                recreate: true,
            });

            pendingRedeploy = undefined;
            onopen(resourceId, "deployments");
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listAllDeployments.key(),
                }),
                refreshGraph(),
            ]);
        } catch (error) {
            redeployError =
                error instanceof Error
                    ? error.message
                    : "The resource could not be redeployed.";
        } finally {
            redeploying = false;
        }
    }

    // Stops or starts the containers in place; the next deploy starts stopped ones again.
    async function setRunning(resourceId: string, running: boolean) {
        await client.resources.setRunning({
            clusterId,
            projectId,
            resourceId,
            running,
        });
        await queryClient.invalidateQueries({
            queryKey: orpc.resources.getProjectContainers.key(),
        });
    }

    async function stop() {
        if (!pendingStop) return;

        stopping = true;
        stopError = "";

        try {
            await setRunning(pendingStop.id, false);
            pendingStop = undefined;
        } catch (error) {
            stopError =
                error instanceof Error
                    ? error.message
                    : "The resource could not be stopped.";
        } finally {
            stopping = false;
        }
    }
</script>

{#if pendingVolumeDelete}
    <ConfirmDialog
        bind:open={
            () => pendingVolumeDelete !== undefined,
            (open) => {
                if (!open && !deletingVolume)
                    pendingVolumeDelete = undefined;
            }
        }
        title={`Delete ${pendingVolumeDelete.volume}?`}
        description="It is unmounted from its services and leaves the Compose file on the next deploy. The data stays on the machines."
        confirmLabel="Delete volume"
        pending={deletingVolume}
        error={volumeDeleteError}
        onconfirm={() => void deleteVolume()}
    />
{/if}

{#if pendingConfigDelete}
    <ConfirmDialog
        bind:open={
            () => pendingConfigDelete !== undefined,
            (open) => {
                if (!open && !deletingConfig)
                    pendingConfigDelete = undefined;
            }
        }
        title={`Delete ${pendingConfigDelete.config}?`}
        description="It is unmounted from its services and leaves the Compose file on the next deploy."
        confirmLabel="Delete config"
        pending={deletingConfig}
        error={configDeleteError}
        onconfirm={() => void deleteConfig()}
    />
{/if}

{#if pendingRedeploy}
    <ConfirmDialog
        bind:open={
            () => pendingRedeploy !== undefined,
            (open) => {
                if (!open && !redeploying)
                    pendingRedeploy = undefined;
            }
        }
        title={`Redeploy ${pendingRedeploy.name}?`}
        description="Its containers are recreated from the live configuration, even if nothing changed. Services may be briefly unavailable while they restart."
        confirmLabel="Redeploy"
        pending={redeploying}
        error={redeployError}
        onconfirm={() => void redeployResource()}
    />
{/if}

{#if pendingStop}
    <ConfirmDialog
        bind:open={
            () => pendingStop !== undefined,
            (open) => {
                if (!open && !stopping) pendingStop = undefined;
            }
        }
        title={`Stop ${pendingStop.name}?`}
        description="Its containers stop and it goes offline until you start it again. Deploying it again also starts it."
        confirmLabel="Stop"
        pending={stopping}
        error={stopError}
        onconfirm={() => void stop()}
    />
{/if}
