<!-- Sets or removes a bucket's storage limit. -->
<script lang="ts">
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
    import { bytes } from "$lib/observability";
    import { orpc, queryClient } from "$lib/api/orpc";
    import type { AppRouterClient } from "@stoat/api/routers/index";
    import { createMutation } from "@tanstack/svelte-query";
    import { untrack } from "svelte";

    type Bucket = Awaited<
        ReturnType<AppRouterClient["buckets"]["get"]>
    >;

    let {
        projectId,
        resourceId,
        bucket,
        open = $bindable(false),
    }: {
        projectId: string;
        resourceId: string;
        bucket: Bucket | undefined;
        open: boolean;
    } = $props();

    const GIB = 1024 ** 3;

    const input = $derived({ projectId, resourceId });

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
                open = false;
            },
        }),
    );

    // Each opening starts from the saved limit.
    $effect(() => {
        if (!open) return;

        untrack(() => {
            saveState.reset();
            draft = bucket?.quota
                ? Number((bucket.quota / GIB).toFixed(2))
                : null;
        });
    });
</script>

<Dialog bind:open>
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
            <Button variant="outline" onclick={() => (open = false)}>
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
