<script lang="ts">
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
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
    import { tick } from "svelte";
    import ConnectionField from "./connection-field.svelte";
    import ProvisionStatusBadge from "./provision-status-badge.svelte";

    const params = useQueryStates(
        { dialog: parseAsString, provisionId: parseAsString },
        { shallow: true, scroll: false },
    );

    // The reset confirmation opens on top of this dialog.
    const open = $derived(
        params.dialog.current === "provision" ||
            params.dialog.current === "reset-provision",
    );

    const provisionId = $derived(params.provisionId.current ?? "");

    const provisionQuery = createQuery(() =>
        orpc.cluster.getProvision.queryOptions({
            input: { provisionId },
            enabled: open && Boolean(provisionId),
            refetchInterval: (query) =>
                query.state.data?.status === "queued" ||
                query.state.data?.status === "running"
                    ? 2000
                    : false,
            retry: false,
        }),
    );

    const provision = $derived(provisionQuery.data);

    const command = $derived(
        provision
            ? `mkdir -p ~/.ssh && echo '${provision.publicKey}' >> ~/.ssh/authorized_keys`
            : "",
    );

    let viewport = $state<HTMLDivElement>();

    let following = $state(true);

    const startMutation = createMutation(() =>
        orpc.cluster.startProvision.mutationOptions({
            onSuccess: async () => {
                following = true;
                await Promise.all([
                    provisionQuery.refetch(),
                    queryClient.invalidateQueries({
                        queryKey:
                            orpc.cluster.listProvisions.queryKey(),
                    }),
                ]);

                if (params.dialog.current === "reset-provision")
                    void params.set({ dialog: "provision" });
            },
        }),
    );

    const startError = $derived(
        startMutation.error
            ? startMutation.error.message ||
                  "Unable to start the setup."
            : "",
    );

    // The new cluster shows up in the list as soon as it is ready.
    let lastStatus = "";

    $effect(() => {
        const status = provision?.status ?? "";

        if (status === lastStatus) return;
        lastStatus = status;

        if (status === "ready" || status === "failed")
            void Promise.all([
                queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listClusters.queryKey(),
                }),
                queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listProvisions.queryKey(),
                }),
            ]);
    });

    // Stick to the newest line while the user stays at the bottom.
    $effect(() => {
        const count = provision?.logs.length ?? 0;

        if (!count || !following) return;
        void tick().then(() => {
            if (viewport) viewport.scrollTop = viewport.scrollHeight;
        });
    });

    function onLogScroll() {
        if (!viewport) return;
        following =
            viewport.scrollHeight -
                viewport.scrollTop -
                viewport.clientHeight <
            24;
    }

    function close() {
        startMutation.reset();
        void params.set({ dialog: null, provisionId: null });
    }

    function start(reset = false) {
        if (!provision || startMutation.isPending) return;

        // A half-created cluster is only reset after an explicit confirmation.
        if (provision.initState === "partial" && !reset) {
            void params.set({ dialog: "reset-provision" });

            return;
        }

        startMutation.mutate({ provisionId: provision.id, reset });
    }
</script>

<Dialog
    bind:open={
        () => open,
        (value) => {
            if (!value && params.dialog.current === "provision")
                close();
        }
    }
>
    <DialogContent class="max-w-2xl">
        <DialogHeader>
            <DialogTitle class="flex items-center gap-2">
                {provision?.name ?? "New server"}
                {#if provision}
                    <ProvisionStatusBadge status={provision.status} />
                {/if}
            </DialogTitle>
            <DialogDescription>
                {#if provision}
                    {provision.user}@{provision.host}:{provision.port}
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
                {#if provision.status === "pending"}
                    <p class="text-sm text-muted-foreground">
                        Authorize this key for <span
                            class="font-mono text-foreground"
                        >
                            {provision.user}
                        </span>
                        and then start the setup. Stoat installs Docker
                        and Uncloud, creates the cluster, and deploys its
                        sidecar. The private key is deleted once the cluster
                        is ready.
                    </p>
                    <ConnectionField
                        label="Public key"
                        value={provision.publicKey}
                    />
                    <ConnectionField
                        label="Or run this on the server"
                        value={command}
                    />
                {:else}
                    {#if provision.status === "failed" && provision.error}
                        <Alert variant="error">
                            <AlertDescription class="break-words">
                                {provision.error}
                            </AlertDescription>
                        </Alert>
                    {:else if provision.status === "ready"}
                        <Alert variant="success">
                            <AlertDescription>
                                The cluster is ready.
                            </AlertDescription>
                        </Alert>
                    {/if}
                    <!-- svelte-ignore a11y_no_noninteractive_tabindex (The named scroll region must support keyboard scrolling.) -->
                    <div
                        bind:this={viewport}
                        class="h-80 overflow-auto rounded-xl bg-code p-3 font-mono text-xs leading-5 text-code-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        tabindex="0"
                        role="log"
                        aria-label="Setup logs"
                        onscroll={onLogScroll}
                    >
                        {#each provision.logs as line (line.id)}
                            <div
                                class={[
                                    "whitespace-pre-wrap break-all",
                                    line.level === "error" &&
                                        "text-destructive-foreground",
                                ]}
                            >
                                {line.text}
                            </div>
                        {:else}
                            <p class="text-muted-foreground">
                                Waiting for the worker...
                            </p>
                        {/each}
                    </div>
                {/if}
            {/if}
        </DialogPanel>
        <DialogFooter>
            <Button variant="outline" onclick={close}>Close</Button>
            {#if provision?.status === "pending"}
                <Button
                    loading={startMutation.isPending}
                    onclick={() => start()}
                >
                    Start setup
                </Button>
            {:else if provision?.status === "failed"}
                <Button
                    loading={startMutation.isPending}
                    onclick={() => start()}
                >
                    Retry
                </Button>
            {:else if provision?.status === "ready" && provision.clusterId}
                <Button href={`/clusters/${provision.clusterId}`}>
                    Open cluster
                </Button>
            {/if}
        </DialogFooter>
    </DialogContent>
</Dialog>

<ConfirmDialog
    bind:open={
        () => params.dialog.current === "reset-provision",
        (value) => {
            if (!value) void params.set({ dialog: "provision" });
        }
    }
    title="Reset the server?"
    description={`The last attempt created a cluster on ${provision?.host ?? "this server"} but didn't finish setting it up. Retrying resets Uncloud on the server and removes its containers.`}
    confirmLabel="Reset and retry"
    pending={startMutation.isPending}
    error={startError}
    onconfirm={() => start(true)}
/>
