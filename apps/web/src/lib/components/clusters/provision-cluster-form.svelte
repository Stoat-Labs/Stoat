<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Checkbox } from "$lib/components/ui/checkbox";
    import {
        Field,
        FieldDescription,
    } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { orpc, queryClient } from "$lib/api/orpc";
    import { createMutation } from "@tanstack/svelte-query";

    // The submit button lives with the caller and targets this form through `formId`.
    let {
        formId,
        pending = $bindable(false),
        canSubmit = $bindable(false),
        oncreated,
    }: {
        formId: string;
        pending?: boolean;
        canSubmit?: boolean;
        oncreated: (clusterId: string) => void;
    } = $props();

    let name = $state("");

    let host = $state("");

    let user = $state("root");

    let port = $state(22);

    let caddyStorage = $state(false);

    const createMutationState = createMutation(() =>
        orpc.cluster.provisionCluster.mutationOptions({
            onSuccess: async (cluster) => {
                await queryClient.invalidateQueries({
                    queryKey: orpc.cluster.listClusters.queryKey(),
                });
                oncreated(cluster.id);
            },
        }),
    );

    $effect(() => {
        pending = createMutationState.isPending;
        canSubmit =
            Boolean(name.trim()) &&
            Boolean(host.trim()) &&
            Boolean(user.trim()) &&
            Number.isInteger(port) &&
            !createMutationState.isPending;
    });

    const errorMessage = $derived(
        createMutationState.error
            ? createMutationState.error.message ||
                  "Unable to set up the server."
            : "",
    );

    function createServerCluster(event: SubmitEvent) {
        event.preventDefault();

        if (!canSubmit) return;
        createMutationState.mutate({
            name: name.trim(),
            host: host.trim(),
            user: user.trim(),
            port,
            caddyStorage,
        });
    }
</script>

{#if errorMessage}
    <Alert variant="error" class="mb-4">
        <AlertDescription>
            {errorMessage}
        </AlertDescription>
    </Alert>
{/if}
<form
    id={formId}
    method="POST"
    onsubmit={createServerCluster}
    class="space-y-4"
    aria-busy={createMutationState.isPending}
>
    <Field>
        <Label for="provision-name" required>Name</Label>
        <Input
            id="provision-name"
            bind:value={name}
            placeholder="Production"
            required
            maxlength={100}
            disabled={createMutationState.isPending}
        />
    </Field>
    <Field>
        <Label for="provision-host" required>Server address</Label>
        <Input
            id="provision-host"
            bind:value={host}
            placeholder="203.0.113.10"
            required
            maxlength={253}
            autocomplete="off"
            spellcheck={false}
            disabled={createMutationState.isPending}
            aria-describedby="provision-host-hint"
        />
        <FieldDescription id="provision-host-hint">
            A fresh Linux server. Stoat connects on port 51443, which
            you can limit to Stoat's IP. Public servers also need 80
            and 443 for your apps.
        </FieldDescription>
    </Field>
    <div class="grid grid-cols-[1fr_7rem] gap-4">
        <Field>
            <Label for="provision-user" required>SSH user</Label>
            <Input
                id="provision-user"
                bind:value={user}
                required
                maxlength={32}
                autocomplete="off"
                spellcheck={false}
                disabled={createMutationState.isPending}
                aria-describedby="provision-user-hint"
            />
            <FieldDescription id="provision-user-hint">
                Root or a user with passwordless sudo.
            </FieldDescription>
        </Field>
        <Field>
            <Label for="provision-port" required>SSH port</Label>
            <Input
                id="provision-port"
                type="number"
                inputmode="numeric"
                bind:value={port}
                min={1}
                max={65535}
                required
                disabled={createMutationState.isPending}
            />
        </Field>
    </div>
    <Field>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
                bind:checked={caddyStorage}
                disabled={createMutationState.isPending}
                aria-describedby="provision-caddy-storage-hint"
            />
            Share Caddy's certificates across machines
        </label>
        <FieldDescription id="provision-caddy-storage-hint">
            Caddy stores certificates and ACME challenges in the
            cluster, so any machine can answer them. Uses Uncloud's
            caddy-uncloud image.
        </FieldDescription>
    </Field>
</form>
