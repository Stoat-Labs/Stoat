<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
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

    let sidecarUrl = $state("");

    let sidecarToken = $state("");

    const createMutationState = createMutation(() =>
        orpc.cluster.createCluster.mutationOptions({
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
            Boolean(sidecarUrl.trim()) &&
            Boolean(sidecarToken.trim()) &&
            !createMutationState.isPending;
    });

    const errorMessage = $derived(
        createMutationState.error
            ? createMutationState.error.message ||
                  "Unable to create cluster."
            : "",
    );

    function createCluster(event: SubmitEvent) {
        event.preventDefault();

        if (createMutationState.isPending) return;

        if (
            !name.trim() ||
            !sidecarUrl.trim() ||
            !sidecarToken.trim()
        )
            return;
        createMutationState.mutate({
            name: name.trim(),
            sidecarUrl: sidecarUrl.trim(),
            sidecarToken: sidecarToken.trim(),
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
    onsubmit={createCluster}
    class="space-y-4"
    aria-busy={createMutationState.isPending}
>
    <Field>
        <Label for="cluster-name" required>Name</Label>
        <Input
            id="cluster-name"
            bind:value={name}
            placeholder="Production"
            required
            maxlength={100}
            disabled={createMutationState.isPending}
        />
    </Field>
    <Field>
        <Label for="cluster-sidecar-url" required>Sidecar URL</Label>
        <Input
            id="cluster-sidecar-url"
            type="url"
            inputmode="url"
            bind:value={sidecarUrl}
            placeholder="https://sidecar.example.com"
            required
            maxlength={500}
            autocomplete="off"
            disabled={createMutationState.isPending}
            aria-describedby="cluster-sidecar-url-hint"
        />
        <FieldDescription id="cluster-sidecar-url-hint">
            Where the cluster's sidecar is reachable.
        </FieldDescription>
    </Field>
    <Field>
        <Label for="cluster-sidecar-token" required>
            Sidecar token
        </Label>
        <Input
            id="cluster-sidecar-token"
            type="password"
            bind:value={sidecarToken}
            placeholder="••••••••"
            required
            maxlength={500}
            autocomplete="new-password"
            disabled={createMutationState.isPending}
            aria-describedby="cluster-sidecar-token-hint"
        />
        <FieldDescription id="cluster-sidecar-token-hint">
            Authenticates Stoat against the sidecar. Never shown again
            after creation.
        </FieldDescription>
    </Field>
</form>
