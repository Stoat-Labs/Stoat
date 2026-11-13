<script lang="ts">
    import { goto } from "$app/navigation";
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
    import {
        Field,
        FieldDescription,
    } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc, queryClient } from "$lib/api/orpc";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { parseAsString, useQueryState } from "nuqs-svelte";
    import ConnectionField from "./connection-field.svelte";

    let { clusterId }: { clusterId: string } = $props();

    const dialog = useQueryState(
        "dialog",
        parseAsString.withOptions({ shallow: true, scroll: false }),
    );

    // The discard confirmation opens on top of this dialog.
    const open = $derived(
        dialog.current === "add-machine" ||
            dialog.current === "discard-machine",
    );

    let host = $state("");

    let user = $state("root");

    let port = $state(22);

    let name = $state("");

    const pendingQuery = createQuery(() =>
        orpc.cluster.getPendingMachine.queryOptions({
            input: { clusterId },
            enabled: open,
            staleTime: 0,
            retry: false,
        }),
    );

    const pending = $derived(pendingQuery.data);

    const command = $derived(
        pending
            ? `mkdir -p ~/.ssh && echo '${pending.publicKey}' >> ~/.ssh/authorized_keys`
            : "",
    );

    const active = $derived(
        pending?.status === "queued" || pending?.status === "running",
    );

    function refresh() {
        return queryClient.invalidateQueries({
            queryKey: orpc.cluster.getPendingMachine.queryKey({
                input: { clusterId },
            }),
        });
    }

    const prepareMutation = createMutation(() =>
        orpc.cluster.prepareMachine.mutationOptions({
            onSuccess: refresh,
        }),
    );

    // Adding runs as a deployment, so its progress is followed on the deployment page.
    const startMutation = createMutation(() =>
        orpc.cluster.addMachine.mutationOptions({
            onSuccess: async ({ deploymentId }) => {
                void refresh();
                await goto(`/deployments/${deploymentId}`);
            },
        }),
    );

    const discardMutation = createMutation(() =>
        orpc.cluster.discardPendingMachine.mutationOptions({
            onSuccess: async () => {
                await refresh();
                void dialog.set("add-machine");
            },
        }),
    );

    const canPrepare = $derived(
        Boolean(host.trim()) &&
            Boolean(user.trim()) &&
            Number.isInteger(port) &&
            !prepareMutation.isPending,
    );

    const error = $derived(
        prepareMutation.error?.message ||
            startMutation.error?.message ||
            "",
    );

    function close() {
        prepareMutation.reset();
        startMutation.reset();
        discardMutation.reset();
        void dialog.set(null);
    }

    function prepare(event: SubmitEvent) {
        event.preventDefault();

        if (!canPrepare) return;
        prepareMutation.mutate({
            clusterId,
            host: host.trim(),
            user: user.trim(),
            port,
            ...(name.trim() && { name: name.trim() }),
        });
    }
</script>

<Dialog
    bind:open={
        () => open,
        (value) => {
            if (!value && dialog.current === "add-machine") close();
        }
    }
>
    <DialogContent class="max-w-2xl">
        <DialogHeader>
            <DialogTitle>Add machine</DialogTitle>
            <DialogDescription>
                {#if pending}
                    {pending.user}@{pending.host}:{pending.port}
                {:else}
                    Join a server to this cluster over SSH.
                {/if}
            </DialogDescription>
        </DialogHeader>
        <DialogPanel class="space-y-4">
            {#if error}
                <Alert variant="error">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            {/if}
            {#if pendingQuery.isPending}
                <Skeleton
                    loading
                    count={2}
                    gap={16}
                    label="Loading the server"
                >
                    <ConnectionField
                        label="Public key"
                        value="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA clowder"
                    />
                </Skeleton>
            {:else if pendingQuery.isError}
                <Alert variant="error">
                    <AlertDescription>
                        {pendingQuery.error.message ||
                            "Unable to load the server."}
                    </AlertDescription>
                </Alert>
            {:else if pending}
                <p class="text-sm text-muted-foreground">
                    {#if active}
                        Clowder is adding this server to the cluster.
                    {:else if pending.joined}
                        <span class="text-foreground">
                            {pending.name}
                        </span>
                        joined the cluster, but Clowder didn't finish starting
                        its services there. Retry to finish.
                    {:else}
                        Authorize this key for <span
                            class="font-mono text-foreground"
                        >
                            {pending.user}
                        </span>
                        and then add the machine. Clowder installs Docker
                        and Uncloud, joins the server through the cluster's
                        sidecar, and starts the sidecar, Caddy and monitoring
                        on it. The private key is deleted once it joins.
                    {/if}
                </p>
                {#if !pending.joined}
                    <ConnectionField
                        label="Public key"
                        value={pending.publicKey}
                    />
                    <ConnectionField
                        label="Or run this on the server"
                        value={command}
                    />
                {/if}
                {#if pending.status === "failed" && pending.deploymentId}
                    <p class="text-sm text-muted-foreground">
                        The last attempt failed. <a
                            href={`/deployments/${pending.deploymentId}`}
                            class="text-foreground underline underline-offset-2"
                        >
                            See what happened
                        </a>
                    </p>
                {/if}
            {:else}
                <form
                    id="add-machine-form"
                    method="POST"
                    onsubmit={prepare}
                    class="space-y-4"
                    aria-busy={prepareMutation.isPending}
                >
                    <Field>
                        <Label for="add-machine-host" required>
                            Server address
                        </Label>
                        <Input
                            id="add-machine-host"
                            bind:value={host}
                            placeholder="203.0.113.20"
                            required
                            maxlength={253}
                            autocomplete="off"
                            spellcheck={false}
                            disabled={prepareMutation.isPending}
                            aria-describedby="add-machine-host-hint"
                        />
                        <FieldDescription id="add-machine-host-hint">
                            A fresh Linux server. It talks to the
                            other machines over WireGuard on UDP port
                            51820.
                        </FieldDescription>
                    </Field>
                    <div class="grid grid-cols-[1fr_7rem] gap-4">
                        <Field>
                            <Label for="add-machine-user" required>
                                SSH user
                            </Label>
                            <Input
                                id="add-machine-user"
                                bind:value={user}
                                required
                                maxlength={32}
                                autocomplete="off"
                                spellcheck={false}
                                disabled={prepareMutation.isPending}
                                aria-describedby="add-machine-user-hint"
                            />
                            <FieldDescription
                                id="add-machine-user-hint"
                            >
                                Root or a user with passwordless sudo.
                            </FieldDescription>
                        </Field>
                        <Field>
                            <Label for="add-machine-port" required>
                                SSH port
                            </Label>
                            <Input
                                id="add-machine-port"
                                type="number"
                                inputmode="numeric"
                                bind:value={port}
                                min={1}
                                max={65535}
                                required
                                disabled={prepareMutation.isPending}
                            />
                        </Field>
                    </div>
                    <Field>
                        <Label for="add-machine-name">
                            Machine name
                        </Label>
                        <Input
                            id="add-machine-name"
                            bind:value={name}
                            placeholder="worker-2"
                            maxlength={63}
                            autocomplete="off"
                            spellcheck={false}
                            disabled={prepareMutation.isPending}
                            aria-describedby="add-machine-name-hint"
                        />
                        <FieldDescription id="add-machine-name-hint">
                            Lowercase letters, digits and hyphens.
                            Leave it empty to name it after the
                            server's hostname.
                        </FieldDescription>
                    </Field>
                </form>
            {/if}
        </DialogPanel>
        <DialogFooter>
            {#if pending && !active}
                <Button
                    variant="destructive-outline"
                    class="sm:mr-auto"
                    onclick={() => void dialog.set("discard-machine")}
                >
                    Discard
                </Button>
            {/if}
            <Button variant="outline" onclick={close}>Close</Button>
            {#if pending && active && pending.deploymentId}
                <Button href={`/deployments/${pending.deploymentId}`}>
                    View progress
                </Button>
            {:else if pending}
                <Button
                    loading={startMutation.isPending}
                    onclick={() =>
                        startMutation.mutate({ clusterId })}
                >
                    {pending.status === "failed"
                        ? "Retry"
                        : "Add machine"}
                </Button>
            {:else if !pendingQuery.isPending && !pendingQuery.isError}
                <Button
                    type="submit"
                    form="add-machine-form"
                    loading={prepareMutation.isPending}
                    disabled={!canPrepare}
                >
                    Continue
                </Button>
            {/if}
        </DialogFooter>
    </DialogContent>
</Dialog>

<ConfirmDialog
    bind:open={
        () => dialog.current === "discard-machine",
        (value) => {
            if (!value) void dialog.set("add-machine");
        }
    }
    title="Discard this server?"
    description={pending?.joined
        ? `${pending.name} stays in the cluster, but Clowder stops finishing its setup and deletes its key.`
        : "Clowder forgets this server and deletes its key. Remove the key from the server's authorized_keys too."}
    confirmLabel="Discard"
    pending={discardMutation.isPending}
    error={discardMutation.error?.message ?? ""}
    onconfirm={() => discardMutation.mutate({ clusterId })}
/>
