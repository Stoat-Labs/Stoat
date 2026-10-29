<script lang="ts">
    import { goto } from "$app/navigation";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc, queryClient } from "$lib/api/orpc";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { parseAsString, useQueryStates } from "nuqs-svelte";
    import ConnectionField from "./connection-field.svelte";

    const params = useQueryStates(
        { dialog: parseAsString, clusterId: parseAsString },
        { shallow: true, scroll: false },
    );

    const open = $derived(params.dialog.current === "provision");

    const clusterId = $derived(params.clusterId.current ?? "");

    const provisionQuery = createQuery(() =>
        orpc.cluster.getProvisioning.queryOptions({
            input: { clusterId },
            enabled: open && Boolean(clusterId),
            retry: false,
        }),
    );

    const provision = $derived(provisionQuery.data);

    const command = $derived(
        provision?.setup
            ? `mkdir -p ~/.ssh && echo '${provision.setup.publicKey}' >> ~/.ssh/authorized_keys`
            : "",
    );

    // Setup runs as a deployment, so its progress is followed on the deployment page.
    const startMutation = createMutation(() =>
        orpc.cluster.startProvisioning.mutationOptions({
            onSuccess: async ({ deploymentId }) => {
                void queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listClusters.queryKey(),
                });
                await goto(`/deployments/${deploymentId}`);
            },
        }),
    );

    const startError = $derived(
        startMutation.error
            ? startMutation.error.message ||
                  "Unable to start the setup."
            : "",
    );

    function close() {
        startMutation.reset();
        void params.set({ dialog: null, clusterId: null });
    }
</script>

<Dialog
    bind:open={
        () => open,
        (value) => {
            if (!value) close();
        }
    }
>
    <DialogContent class="max-w-2xl">
        <DialogHeader>
            <DialogTitle>
                {provision?.name ?? "New server"}
            </DialogTitle>
            <DialogDescription>
                {#if provision?.setup}
                    {provision.setup.user}@{provision.setup
                        .host}:{provision.setup.port}
                {:else}
                    Setting up a server over SSH.
                {/if}
            </DialogDescription>
        </DialogHeader>
        <DialogPanel class="space-y-4">
            {#if provisionQuery.isPending}
                <Skeleton
                    loading
                    count={2}
                    count-gap={16}
                    loading-label="Loading setup"
                >
                    <ConnectionField
                        label="Public key"
                        value="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA stoat"
                    />
                </Skeleton>
            {:else if provisionQuery.isError}
                <Alert variant="error">
                    <AlertDescription>
                        {provisionQuery.error.message ||
                            "Unable to load the setup."}
                    </AlertDescription>
                </Alert>
            {:else if provision}
                {#if startError}
                    <Alert variant="error">
                        <AlertDescription>
                            {startError}
                        </AlertDescription>
                    </Alert>
                {/if}
                <p class="text-sm text-muted-foreground">
                    Authorize this key for <span
                        class="font-mono text-foreground"
                    >
                        {provision.setup?.user}
                    </span>
                    and then start the setup. Stoat installs Docker and
                    Uncloud, creates the cluster, and deploys its sidecar.
                    The private key is deleted once the cluster is ready.
                </p>
                <ConnectionField
                    label="Public key"
                    value={provision.setup?.publicKey ?? ""}
                />
                <ConnectionField
                    label="Or run this on the server"
                    value={command}
                />
            {/if}
        </DialogPanel>
        <DialogFooter>
            <Button variant="outline" onclick={close}>Close</Button>
            {#if provision?.status === "pending"}
                <Button
                    loading={startMutation.isPending}
                    onclick={() =>
                        startMutation.mutate({
                            clusterId: provision.id,
                        })}
                >
                    Start setup
                </Button>
            {/if}
        </DialogFooter>
    </DialogContent>
</Dialog>
