<script lang="ts">
    import {
        Alert,
        AlertAction,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Card,
        CardFooter,
        CardPanel,
    } from "$lib/components/ui/card";
    import {
        Field,
        FieldDescription,
    } from "$lib/components/ui/field";
    import { Label } from "$lib/components/ui/label";
    import { Spinner } from "$lib/components/ui/spinner";
    import { Switch } from "$lib/components/ui/switch";
    import { orpc, queryClient } from "$lib/api/orpc";
    import Check from "@lucide/svelte/icons/check";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { untrack } from "svelte";
    import { fade } from "svelte/transition";
    import { z } from "zod";

    let {
        projectId,
        resourceId,
    }: {
        projectId: string;
        resourceId: string;
    } = $props();

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({
            input: { projectId, resourceId },
        }),
    );

    const prefixNamesSchema = z
        .object({ prefixNames: z.boolean().catch(false) })
        .catch({ prefixNames: false });

    let prefixNames = $state(false);

    let savedPrefixNames = $state(false);

    let loadedResourceId = $state("");

    let failedValue = $state<boolean | null>(null);

    const isDirty = $derived(prefixNames !== savedPrefixNames);

    const saveMutation = createMutation(() =>
        orpc.resources.updateSettings.mutationOptions({
            onSuccess: (updated, input) => {
                if (loadedResourceId === updated.id) {
                    failedValue = null;
                    savedPrefixNames = prefixNamesSchema.parse(
                        updated.settings,
                    ).prefixNames;
                }

                queryClient.setQueryData(
                    orpc.resources.getResource.queryKey({
                        input: {
                            projectId: input.projectId,
                            resourceId: input.resourceId,
                        },
                    }),
                    updated,
                );
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.queryKey({
                        input: { projectId: input.projectId },
                    }),
                });
            },
            onError: (_error, input) => {
                if (loadedResourceId === input.resourceId)
                    failedValue = input.prefixNames;
            },
        }),
    );

    $effect(() => {
        const current = resourceQuery.data;

        if (!current) return;
        untrack(() => {
            const saved = prefixNamesSchema.parse(
                current.settings,
            ).prefixNames;

            if (loadedResourceId !== current.id) {
                loadedResourceId = current.id;
                prefixNames = saved;
                savedPrefixNames = saved;
                failedValue = null;
                saveMutation.reset();
            } else if (!isDirty) {
                prefixNames = saved;
                savedPrefixNames = saved;
            }
        });
    });

    $effect(() => {
        if (!isDirty) {
            failedValue = null;

            return;
        }

        if (
            loadedResourceId !== resourceId ||
            saveMutation.isPending ||
            failedValue === prefixNames
        )
            return;

        const input = { projectId, resourceId, prefixNames };

        untrack(() => saveMutation.mutate(input));
    });

    function retrySave() {
        failedValue = null;
        saveMutation.reset();
    }
</script>

<section
    class="grid gap-5 md:grid-cols-3 md:gap-8"
    aria-labelledby="compose-settings-heading"
>
    <div>
        <h2
            id="compose-settings-heading"
            class="text-lg font-semibold leading-tight tracking-tight"
        >
            Compose settings
        </h2>
        <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
            Configure how names in this resource's Compose spec are
            handled.
        </p>
    </div>

    <div class="md:col-span-2">
        <Card>
            <CardPanel class="p-5 sm:p-6">
                <div class="flex items-center justify-between gap-6">
                    <Field class="min-w-0 gap-1">
                        <Label for="prefix-names">Prefix names</Label>
                        <FieldDescription
                            id="prefix-names-description"
                            class="leading-snug"
                        >
                            Prefix service, network, and volume names
                            in the Compose spec with this resource's
                            name so they are unique across the
                            cluster.
                        </FieldDescription>
                    </Field>
                    <div class="flex shrink-0 items-center gap-3">
                        <span
                            class="grid size-4 place-items-center text-muted-foreground"
                            aria-live="polite"
                        >
                            {#if saveMutation.isPending || isDirty}
                                <span
                                    transition:fade={{
                                        duration: 150,
                                    }}
                                    class="col-start-1 row-start-1"
                                >
                                    <Spinner class="size-4" />
                                    <span class="sr-only">
                                        Saving…
                                    </span>
                                </span>
                            {:else if saveMutation.isSuccess}
                                <span
                                    transition:fade={{
                                        duration: 150,
                                    }}
                                    class="col-start-1 row-start-1"
                                    title="Saved"
                                >
                                    <Check class="size-4" />
                                    <span class="sr-only">Saved</span>
                                </span>
                            {/if}
                        </span>
                        <Switch
                            id="prefix-names"
                            aria-describedby="prefix-names-description"
                            bind:checked={prefixNames}
                        />
                    </div>
                </div>
            </CardPanel>
            {#if saveMutation.isError && failedValue === prefixNames}
                <CardFooter class="border-t px-5 py-3 sm:px-6">
                    <Alert variant="error" class="py-2">
                        <AlertDescription>
                            Unable to save: {saveMutation.error
                                .message}
                        </AlertDescription>
                        <AlertAction>
                            <Button
                                variant="link"
                                size="sm"
                                class="h-auto p-0"
                                onclick={retrySave}
                            >
                                Retry
                            </Button>
                        </AlertAction>
                    </Alert>
                </CardFooter>
            {/if}
        </Card>
    </div>
</section>
