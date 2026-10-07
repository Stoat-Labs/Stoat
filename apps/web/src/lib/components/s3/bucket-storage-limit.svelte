<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Card, CardPanel } from "$lib/components/ui/card";
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
    import { bytes } from "$lib/observability";
    import { orpc, queryClient } from "$lib/api/orpc";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { parseAsBoolean, useQueryStates } from "nuqs-svelte";

    let {
        projectId,
        resourceId,
    }: { projectId: string; resourceId: string } = $props();

    const GIB = 1024 ** 3;

    const input = $derived({ projectId, resourceId });

    const bucketQuery = createQuery(() =>
        orpc.buckets.get.queryOptions({ input, retry: false }),
    );

    const bucket = $derived(bucketQuery.data);

    const view = useQueryStates(
        { limitDialog: parseAsBoolean.withDefault(false) },
        { shallow: true, scroll: false },
    );

    // A number input binds null while empty.
    let draft = $state<number | null>(null);

    const draftBytes = $derived(Math.round((draft ?? 0) * GIB));

    const isDraftValid = $derived(
        Number.isSafeInteger(draftBytes) && draftBytes > 0,
    );

    const saveState = createMutation(() =>
        orpc.buckets.setQuota.mutationOptions({
            onSuccess: async () => {
                await queryClient.invalidateQueries({
                    queryKey: orpc.buckets.get.queryKey({ input }),
                });
                await view.set({ limitDialog: false });
            },
        }),
    );

    function openDialog() {
        saveState.reset();
        draft = bucket?.quota
            ? Number((bucket.quota / GIB).toFixed(2))
            : null;
        void view.set({ limitDialog: true });
    }
</script>

<section
    class="grid gap-5 md:grid-cols-3 md:gap-8"
    aria-labelledby="storage-limit-heading"
>
    <div>
        <h2
            id="storage-limit-heading"
            class="text-lg font-semibold leading-tight tracking-tight"
        >
            Storage limit
        </h2>
        <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
            Cap how much this bucket can hold.
        </p>
    </div>

    <div class="md:col-span-2">
        <Card>
            <CardPanel
                class="flex flex-wrap items-center justify-between gap-4 p-5 sm:p-6"
            >
                {#if bucket}
                    <div class="min-w-0 space-y-1">
                        <h3 class="text-sm font-medium">
                            {bucket.quota
                                ? bytes(bucket.quota)
                                : "No limit"}
                        </h3>
                        <p class="text-sm text-muted-foreground">
                            {bucket.enforcedQuota
                                ? `${bucket.connection.providerName} rejects uploads past the limit.`
                                : `Display only: ${bucket.connection.providerName} cannot enforce a limit.`}
                        </p>
                    </div>
                    <Button
                        variant="outline"
                        disabled={bucket.status !== "ready"}
                        onclick={openDialog}
                    >
                        {bucket.quota ? "Edit limit" : "Set limit"}
                    </Button>
                {:else}
                    <Skeleton
                        loading
                        loading-label="Loading storage limit"
                    >
                        <div class="space-y-1">
                            <h3 class="text-sm font-medium">
                                No limit
                            </h3>
                            <p class="text-sm">
                                RustFS rejects uploads past the limit.
                            </p>
                        </div>
                    </Skeleton>
                {/if}
            </CardPanel>
        </Card>
    </div>
</section>

<Dialog
    bind:open={
        () => view.limitDialog.current,
        (open) => {
            if (!open) void view.set({ limitDialog: false });
        }
    }
>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Storage limit</DialogTitle>
            <DialogDescription>
                {bucket?.enforcedQuota
                    ? "Uploads that would push the bucket past this size are rejected. Usage updates hourly."
                    : "Shown on the bucket overview. This provider cannot enforce it."}
            </DialogDescription>
        </DialogHeader>
        <DialogPanel>
            <div class="space-y-4">
                <Field>
                    <Label for="storage-limit">Limit (GiB)</Label>
                    <Input
                        id="storage-limit"
                        type="number"
                        min="0.01"
                        step="any"
                        inputmode="decimal"
                        bind:value={draft}
                        placeholder="10"
                    />
                    {#if bucket?.usage}
                        <FieldDescription>
                            Currently using {bytes(
                                bucket.usage.size,
                            )}.
                        </FieldDescription>
                    {/if}
                </Field>
                {#if saveState.error}
                    <Alert variant="error">
                        <AlertDescription>
                            {saveState.error.message}
                        </AlertDescription>
                    </Alert>
                {/if}
            </div>
        </DialogPanel>
        <DialogFooter>
            {#if bucket?.quota}
                <Button
                    variant="ghost"
                    class="sm:mr-auto"
                    disabled={saveState.isPending}
                    onclick={() =>
                        saveState.mutate({ ...input, quota: null })}
                >
                    Remove limit
                </Button>
            {/if}
            <Button
                variant="outline"
                onclick={() => void view.set({ limitDialog: false })}
            >
                Cancel
            </Button>
            <Button
                disabled={!isDraftValid}
                loading={saveState.isPending}
                onclick={() =>
                    saveState.mutate({ ...input, quota: draftBytes })}
            >
                Save limit
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
