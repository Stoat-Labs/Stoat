<script lang="ts">
    import {
        Alert,
        AlertDescription,
        AlertTitle,
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
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc, queryClient } from "$lib/orpc";
    import Info from "@lucide/svelte/icons/info";
    import Server from "@lucide/svelte/icons/server";
    import ShieldCheck from "@lucide/svelte/icons/shield-check";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { watch } from "runed";

    let {
        open = $bindable(false),
        clusterId,
        mode = "initialize",
        onInitialized,
    }: {
        open?: boolean;
        clusterId: string;
        mode?: "initialize" | "reinitialize";
        onInitialized?: (
            deploymentId: string,
            originatingClusterId: string,
        ) => void;
    } = $props();

    let machine = $state("");

    let retentionDays = $state(14);

    let hydratedForOpen = $state(false);

    const optionsQuery = createQuery(() =>
        orpc.cluster.getInitializationOptions.queryOptions({
            input: { clusterId },
            enabled: open && clusterId.length > 0,
        }),
    );

    const machines = $derived(optionsQuery.data?.machines ?? []);

    const isReinitialize = $derived(mode === "reinitialize");

    async function handleSubmitted(
        data: { deploymentId: string },
        variables: { clusterId: string },
    ) {
        await Promise.all([
            queryClient.invalidateQueries({
                queryKey: orpc.cluster.getCluster.queryKey({
                    input: { clusterId: variables.clusterId },
                }),
            }),
            queryClient.invalidateQueries({
                queryKey:
                    orpc.cluster.getInitializationOptions.queryKey({
                        input: { clusterId: variables.clusterId },
                    }),
            }),
        ]);

        if (clusterId === variables.clusterId) open = false;

        if (data?.deploymentId)
            onInitialized?.(data.deploymentId, variables.clusterId);
    }

    const initializeMutationState = createMutation(() =>
        isReinitialize
            ? orpc.cluster.retryInitialization.mutationOptions({
                  onSuccess: handleSubmitted,
              })
            : orpc.cluster.initializeCluster.mutationOptions({
                  onSuccess: handleSubmitted,
              }),
    );

    const errorMessage = $derived(
        initializeMutationState.error
            ? initializeMutationState.error.message ||
                  (isReinitialize
                      ? "Unable to reinitialize the cluster."
                      : "Unable to initialize the cluster.")
            : "",
    );

    watch(
        () => open,
        (isOpen, wasOpen) => {
            if (isOpen && wasOpen !== true) {
                resetForm();
            }
        },
    );

    // Apply a saved configuration once per dialog opening. Storage is now
    // fixed, so only the machine and retention carry over.
    watch([() => open, () => optionsQuery.data], ([isOpen, data]) => {
        if (!isOpen || !data || hydratedForOpen) return;
        const current = data;
        const saved = current.configuration;
        machine = saved?.machine ?? current.machines[0]?.name ?? "";
        retentionDays = saved?.retentionDays ?? 14;
        hydratedForOpen = true;
    });

    function resetForm() {
        machine = "";
        retentionDays = 14;
        hydratedForOpen = false;
        initializeMutationState.reset();
    }

    // The number input crosses the Input component boundary as a string,
    // so coerce before validating. Without this, Number.isInteger("365")
    // is false and every typed value looks invalid.
    const retentionDaysValue = $derived(Number(retentionDays));

    const retentionIsValid = $derived(
        Number.isInteger(retentionDaysValue) &&
            retentionDaysValue >= 1 &&
            retentionDaysValue <= 365,
    );

    const canSubmit = $derived(
        Boolean(machine) &&
            retentionIsValid &&
            !initializeMutationState.isPending,
    );

    function submitInitialization(event: SubmitEvent) {
        event.preventDefault();

        if (!canSubmit) return;

        initializeMutationState.mutate({
            clusterId,
            configuration: {
                machine,
                retentionDays: retentionDaysValue,
            },
        });
    }
</script>

<Dialog bind:open>
    <DialogContent class="sm:max-w-lg">
        <DialogHeader>
            <DialogTitle>
                {isReinitialize
                    ? "Reinitialize cluster monitoring"
                    : "Initialize cluster monitoring"}
            </DialogTitle>
            <DialogDescription>
                Deploy the internal monitoring stack. No public ports
                or ingress routes are created.
            </DialogDescription>
        </DialogHeader>

        <DialogPanel>
            {#if optionsQuery.isPending}
                <Skeleton
                    loading
                    loading-label="Loading initialization options"
                >
                    <div class="space-y-4">
                        <div>
                            <Label>Machine</Label>
                            <p
                                class="mt-2 rounded-lg border border-border p-3 text-sm"
                            >
                                Primary cluster machine
                            </p>
                        </div>
                        <div>
                            <Label>Retention period</Label>
                            <p
                                class="mt-2 rounded-lg border border-border p-3 text-sm"
                            >
                                14 days
                            </p>
                        </div>
                    </div>
                </Skeleton>
            {:else if optionsQuery.isError}
                <Alert variant="error">
                    <Info aria-hidden="true" />
                    <AlertTitle>
                        Could not load cluster options
                    </AlertTitle>
                    <AlertDescription>
                        {(optionsQuery.error as Error).message ||
                            "The cluster sidecar did not return its available machines."}
                    </AlertDescription>
                </Alert>
            {:else if machines.length === 0}
                <Alert variant="warning">
                    <Server aria-hidden="true" />
                    <AlertTitle>No available machines</AlertTitle>
                    <AlertDescription>
                        Add an available machine to the cluster before
                        initializing monitoring.
                    </AlertDescription>
                </Alert>
            {:else}
                {#if errorMessage}
                    <Alert variant="error" class="mb-4">
                        <Info aria-hidden="true" />
                        <AlertDescription>
                            {errorMessage}
                        </AlertDescription>
                    </Alert>
                {/if}

                <form
                    id="initialize-cluster-form"
                    method="POST"
                    onsubmit={submitInitialization}
                    class="space-y-5"
                    aria-busy={initializeMutationState.isPending}
                >
                    <Field>
                        <Label for="initialization-machine" required>
                            Deployment machine
                        </Label>
                        <Select
                            bind:value={machine}
                            items={machines.map((item) => ({
                                label: item.name,
                                value: item.name,
                            }))}
                        >
                            <SelectTrigger
                                id="initialization-machine"
                                aria-label="Select deployment machine"
                            >
                                <SelectValue
                                    placeholder="Select a machine"
                                />
                            </SelectTrigger>
                            <SelectContent>
                                {#each machines as item (item.name)}
                                    <SelectItem
                                        value={item.name}
                                        label={item.name}
                                    >
                                        <span
                                            class="flex min-w-0 items-center gap-2"
                                        >
                                            <Server
                                                class="size-4 shrink-0 text-muted-foreground"
                                                aria-hidden="true"
                                            />
                                            <span class="truncate">
                                                {item.name}
                                            </span>
                                            <span
                                                class="text-xs text-muted-foreground"
                                            >
                                                {item.state}
                                            </span>
                                        </span>
                                    </SelectItem>
                                {/each}
                            </SelectContent>
                        </Select>
                        <FieldDescription>
                            GreptimeDB runs here. Alloy runs
                            everywhere and reports back to it.
                        </FieldDescription>
                    </Field>

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
                                bind:value={retentionDays}
                                aria-invalid={retentionIsValid
                                    ? undefined
                                    : true}
                            />
                            <InputGroupAddon align="inline-end">
                                days
                            </InputGroupAddon>
                        </InputGroup>
                        <FieldDescription>
                            Choose between 1 and 365 days of
                            monitoring data.
                        </FieldDescription>
                    </Field>

                    <Alert variant="info">
                        <ShieldCheck aria-hidden="true" />
                        <AlertDescription>
                            Deploys as <span class="font-mono">
                                stoat-monitoring
                            </span>
                            with volumes
                            <span class="font-mono">
                                stoat-monitoring-greptime
                            </span>
                            and
                            <span class="font-mono">
                                stoat-monitoring-alloy
                            </span>
                            , created automatically.
                        </AlertDescription>
                    </Alert>
                </form>
            {/if}
        </DialogPanel>

        {#if !optionsQuery.isPending && !optionsQuery.isError && machines.length > 0}
            <DialogFooter>
                <Button
                    variant="outline"
                    disabled={initializeMutationState.isPending}
                    onclick={() => {
                        open = false;
                    }}
                >
                    Cancel
                </Button>
                <Button
                    type="submit"
                    form="initialize-cluster-form"
                    loading={initializeMutationState.isPending}
                    disabled={!canSubmit}
                >
                    {isReinitialize
                        ? "Save and reinitialize"
                        : "Initialize monitoring"}
                </Button>
            </DialogFooter>
        {/if}
    </DialogContent>
</Dialog>
