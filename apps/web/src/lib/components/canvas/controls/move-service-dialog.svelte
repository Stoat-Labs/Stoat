<!-- Moves one service of a resource's Compose into another resource's, or out into a new one. -->
<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import { Field } from "$lib/components/ui/field";
    import { Label } from "$lib/components/ui/label";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { untrack } from "svelte";
    import type { CanvasResource } from "../graph";

    let {
        resource,
        services,
        targets,
        pending,
        error,
        onmove,
        onclose,
    }: {
        resource: CanvasResource;
        services: string[];
        /** The other Compose resources a service can move into. */
        targets: CanvasResource[];
        pending: boolean;
        error: string;
        /** `null` moves the service into a new resource of its own. */
        onmove: (
            service: string,
            toResourceId: string | null,
        ) => void;
        onclose: () => void;
    } = $props();

    // A resource's only service is the resource, so it can't split out into a new one.
    const NEW = "new";

    let service = $state(untrack(() => services[0] ?? ""));

    let destination = $state(
        untrack(() => (services.length > 1 ? NEW : "")),
    );

    const destinations = $derived([
        ...(services.length > 1
            ? [{ value: NEW, label: "A new resource" }]
            : []),
        ...targets.map((target) => ({
            value: target.id,
            label: target.name,
        })),
    ]);

    const target = $derived(
        targets.find((entry) => entry.id === destination),
    );

    const ready = $derived(
        Boolean(service) && Boolean(destination) && !pending,
    );
</script>

<Dialog
    bind:open={
        () => true,
        (open) => {
            if (!open && !pending) onclose();
        }
    }
>
    <DialogContent class="sm:max-w-md">
        <DialogHeader>
            <DialogTitle>
                Move a service of {resource.name}
            </DialogTitle>
        </DialogHeader>
        <DialogPanel>
            <form
                id="canvas-move-service-form"
                class="space-y-4"
                onsubmit={(event) => {
                    event.preventDefault();
                    if (ready)
                        onmove(
                            service,
                            destination === NEW ? null : destination,
                        );
                }}
            >
                {#if services.length > 1}
                    <Field>
                        <Label for="canvas-move-service" required>
                            Service
                        </Label>
                        <Select
                            value={service || null}
                            items={services.map((name) => ({
                                value: name,
                                label: name,
                            }))}
                            onValueChange={(value) =>
                                (service = value ?? "")}
                        >
                            <SelectTrigger id="canvas-move-service">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {#each services as name (name)}
                                    <SelectItem
                                        value={name}
                                        label={name}
                                    />
                                {/each}
                            </SelectContent>
                        </Select>
                    </Field>
                {/if}

                <Field>
                    <Label for="canvas-move-destination" required>
                        Into
                    </Label>
                    <Select
                        value={destination || null}
                        items={destinations}
                        onValueChange={(value) =>
                            (destination = value ?? "")}
                    >
                        <SelectTrigger id="canvas-move-destination">
                            <SelectValue
                                placeholder="Choose a resource"
                            />
                        </SelectTrigger>
                        <SelectContent>
                            {#each destinations as option (option.value)}
                                <SelectItem
                                    value={option.value}
                                    label={option.label}
                                />
                            {/each}
                        </SelectContent>
                    </Select>
                </Field>

                {#if services.length === 1 && target}
                    <Alert variant="warning">
                        <AlertDescription>
                            {service} is the only service of {resource.name},
                            so {resource.name} is removed now, stopping
                            its containers. Volumes keep their data and
                            stay on the machines. Deploy {target.name} to
                            start the service there.
                        </AlertDescription>
                    </Alert>
                {/if}

                {#if error}
                    <Alert variant="error">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                {/if}
            </form>
        </DialogPanel>
        <DialogFooter>
            <Button
                variant="outline"
                onclick={onclose}
                disabled={pending}
            >
                Cancel
            </Button>
            <Button
                type="submit"
                form="canvas-move-service-form"
                variant={services.length === 1
                    ? "destructive"
                    : "default"}
                loading={pending}
                disabled={!ready}
            >
                {services.length === 1 ? "Move and remove" : "Move"}
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
