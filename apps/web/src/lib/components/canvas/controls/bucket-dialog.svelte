<!-- Names a bucket before it lands on the canvas. -->
<script lang="ts">
    import ProviderIcon from "$lib/components/s3/provider-icon.svelte";
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
    import type { S3ProviderId } from "@stoat/s3/providers";
    import { s3Providers } from "@stoat/s3/providers";

    let {
        connection,
        pending,
        error,
        onsubmit,
        onclose,
    }: {
        connection: { name: string; provider: S3ProviderId };
        pending: boolean;
        error: string;
        onsubmit: (name: string, bucket: string) => void;
        onclose: () => void;
    } = $props();

    let name = $state("");

    // Suggest a bucket name from the resource name until one is typed.
    let typedBucket = $state<string | null>(null);

    const bucket = $derived(
        typedBucket ??
            name
                .toLowerCase()
                .replace(/[^a-z0-9-]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .slice(0, 63),
    );

    const ready = $derived(name.trim() !== "" && bucket.length >= 3);
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
            <div class="flex items-center gap-3">
                <ProviderIcon
                    provider={connection.provider}
                    class="size-8"
                />
                <div class="min-w-0">
                    <DialogTitle>New bucket</DialogTitle>
                    <DialogDescription>
                        On {connection.name}
                    </DialogDescription>
                </div>
            </div>
        </DialogHeader>
        <DialogPanel>
            <form
                id="canvas-bucket-form"
                class="space-y-4"
                onsubmit={(event) => {
                    event.preventDefault();

                    if (ready && !pending)
                        onsubmit(name.trim(), bucket);
                }}
            >
                {#if error}
                    <Alert variant="error">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                {/if}
                <Field>
                    <Label for="canvas-bucket-name" required>
                        Name
                    </Label>
                    <Input
                        id="canvas-bucket-name"
                        bind:value={name}
                        placeholder="Uploads"
                        autofocus
                        autocomplete="off"
                        maxlength={100}
                        disabled={pending}
                    />
                </Field>
                <Field>
                    <Label for="canvas-bucket-bucket" required>
                        Bucket name
                    </Label>
                    <Input
                        id="canvas-bucket-bucket"
                        bind:value={
                            () => bucket,
                            (value) => (typedBucket = value)
                        }
                        placeholder="uploads"
                        autocomplete="off"
                        spellcheck={false}
                        class="font-mono"
                        maxlength={63}
                        disabled={pending}
                    />
                    <FieldDescription>
                        3-63 lowercase letters, digits, or hyphens.
                        {#if !s3Providers[connection.provider].scopedKeys}
                            {s3Providers[connection.provider].name} can't
                            scope keys, so this bucket shares the connection's
                            access keys.
                        {/if}
                    </FieldDescription>
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
                form="canvas-bucket-form"
                loading={pending}
                disabled={!ready}
            >
                Add to canvas
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
