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
    import {
        InputGroup,
        InputGroupAddon,
        InputGroupInput,
    } from "$lib/components/ui/input-group";
    import { Label } from "$lib/components/ui/label";
    import { orpc, queryClient } from "$lib/orpc";
    import Info from "@lucide/svelte/icons/info";
    import { createMutation } from "@tanstack/svelte-query";
    import { watch } from "runed";

    let {
        open = $bindable(false),
        clusterId,
        currentDays,
    }: {
        open?: boolean;
        clusterId: string;
        currentDays: number;
    } = $props();

    let days = $state(14);

    watch(
        () => open,
        (isOpen, wasOpen) => {
            if (isOpen && wasOpen !== true) {
                days = currentDays;
                updateMutationState.reset();
            }
        },
    );

    const updateMutationState = createMutation(() =>
        orpc.cluster.updateRetention.mutationOptions({
            onSuccess: (_data, variables) => {
                void queryClient.invalidateQueries({
                    queryKey: orpc.cluster.getCluster.queryKey({
                        input: { clusterId: variables.clusterId },
                    }),
                });
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.key(),
                });

                if (clusterId === variables.clusterId) open = false;
            },
        }),
    );

    const errorMessage = $derived(
        updateMutationState.error?.message || "",
    );

    // The number input crosses the Input component boundary as a string,
    // so coerce before validating. Without this, Number.isInteger("365")
    // is false and every typed value looks invalid.
    const daysValue = $derived(Number(days));

    const daysIsValid = $derived(
        Number.isInteger(daysValue) &&
            daysValue >= 1 &&
            daysValue <= 365,
    );

    const canSubmit = $derived(
        daysIsValid && !updateMutationState.isPending,
    );

    function submitRetention(event: SubmitEvent) {
        event.preventDefault();

        if (!canSubmit) return;

        updateMutationState.mutate({
            clusterId,
            retentionDays: daysValue,
        });
    }
</script>

<Dialog bind:open>
    <DialogContent class="sm:max-w-md">
        <DialogHeader>
            <DialogTitle>Change retention period</DialogTitle>
            <DialogDescription>
                Applies to existing monitoring data immediately. No
                redeploy needed.
            </DialogDescription>
        </DialogHeader>

        <DialogPanel>
            {#if errorMessage}
                <Alert variant="error" class="mb-4">
                    <Info aria-hidden="true" />
                    <AlertDescription>
                        {errorMessage}
                    </AlertDescription>
                </Alert>
            {/if}

            <form
                id="retention-form"
                method="POST"
                onsubmit={submitRetention}
                aria-busy={updateMutationState.isPending}
            >
                <Field>
                    <Label for="retention-days" required>
                        Retention period
                    </Label>
                    <InputGroup class="max-w-40">
                        <InputGroupInput
                            id="retention-days"
                            type="number"
                            min="1"
                            max="365"
                            step="1"
                            bind:value={days}
                            aria-invalid={daysIsValid
                                ? undefined
                                : true}
                        />
                        <InputGroupAddon align="inline-end">
                            days
                        </InputGroupAddon>
                    </InputGroup>
                    <FieldDescription>
                        Choose between 1 and 365 days of monitoring
                        data.
                    </FieldDescription>
                </Field>
            </form>
        </DialogPanel>

        <DialogFooter>
            <Button
                variant="outline"
                disabled={updateMutationState.isPending}
                onclick={() => {
                    open = false;
                }}
            >
                Cancel
            </Button>
            <Button
                type="submit"
                form="retention-form"
                loading={updateMutationState.isPending}
                disabled={!canSubmit}
            >
                Save retention
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
