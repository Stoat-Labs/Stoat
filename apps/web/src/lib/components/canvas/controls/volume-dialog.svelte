<!-- Connects an existing volume to a service. -->
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
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import type { VolumeTarget } from "../graph";

    let {
        targets,
        volume,
        pending,
        error,
        onsubmit,
        onclose,
    }: {
        /** Services the volume can be mounted into. */
        targets: VolumeTarget[];
        volume: string;
        pending: boolean;
        error: string;
        onsubmit: (target: VolumeTarget, path: string) => void;
        onclose: () => void;
    } = $props();

    let path = $state("");

    const keyOf = (target: VolumeTarget) =>
        `${target.resourceId}:${target.service}`;

    // A lone service needs no choosing.
    let key = $state(targets.length === 1 ? keyOf(targets[0]!) : "");

    const items = $derived(
        targets.map((target) => ({
            label: target.label,
            value: keyOf(target),
        })),
    );

    const chosen = $derived(
        targets.find((target) => keyOf(target) === key),
    );

    const ready = $derived(
        chosen !== undefined && path.startsWith("/"),
    );
</script>

<Dialog
    bind:open={
        () => true,
        (open) => {
            if (!open) onclose();
        }
    }
>
    <DialogContent class="sm:max-w-md">
        <DialogHeader>
            <DialogTitle>
                Connect {volume}
            </DialogTitle>
        </DialogHeader>
        <DialogPanel>
            <form
                id="canvas-volume-form"
                class="space-y-4"
                onsubmit={(event) => {
                    event.preventDefault();

                    if (ready && chosen && !pending)
                        onsubmit(chosen, path);
                }}
            >
                {#if error}
                    <Alert variant="error">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                {/if}
                {#if targets.length > 1}
                    <Field>
                        <Label for="canvas-volume-service" required>
                            Service
                        </Label>
                        <Select
                            bind:value={key}
                            {items}
                            disabled={pending}
                            required
                        >
                            <SelectTrigger
                                id="canvas-volume-service"
                                aria-label="Service"
                            >
                                <SelectValue
                                    placeholder="Select a service"
                                />
                            </SelectTrigger>
                            <SelectContent>
                                {#each targets as target (keyOf(target))}
                                    <SelectItem
                                        value={keyOf(target)}
                                        label={target.label}
                                    >
                                        {target.label}
                                    </SelectItem>
                                {/each}
                            </SelectContent>
                        </Select>
                    </Field>
                {/if}
                <Field>
                    <Label for="canvas-volume-path" required>
                        Mount path
                    </Label>
                    <Input
                        id="canvas-volume-path"
                        bind:value={path}
                        placeholder="/data"
                        autocomplete="off"
                        spellcheck={false}
                        class="font-mono"
                        maxlength={512}
                        disabled={pending}
                    />
                </Field>
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
                form="canvas-volume-form"
                loading={pending}
                disabled={!ready}
            >
                Connect
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
