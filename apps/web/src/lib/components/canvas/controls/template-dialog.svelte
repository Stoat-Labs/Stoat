<!-- Fills in a template's required variables before it lands on the canvas. -->
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
    import { Field } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import type { AppRouterClient } from "@stoat/api/routers/index";
    import KeyRound from "@lucide/svelte/icons/key-round";

    type Template = Awaited<
        ReturnType<AppRouterClient["resources"]["listTemplates"]>
    >[number];

    let {
        template,
        pending,
        error,
        onsubmit,
        onclose,
    }: {
        template: Template;
        pending: boolean;
        error: string;
        onsubmit: (variables: Record<string, string>) => void;
        onclose: () => void;
    } = $props();

    // Template inputs may hold secrets, so they stay out of the URL.
    let variables = $state<Record<string, string>>({});

    // Newest first, like the create page's default.
    const version = $derived(template.versions[0]);

    const ready = $derived(
        version?.required.every((key) => variables[key]?.trim()) ??
            false,
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
            <div class="flex items-center gap-3">
                {#if template.logo}
                    <img
                        src={template.logo}
                        alt=""
                        aria-hidden="true"
                        class="size-8 shrink-0 object-contain"
                    />
                {/if}
                <div class="min-w-0">
                    <DialogTitle>{template.name}</DialogTitle>
                    <DialogDescription>
                        Fill in what it needs. It is added to the
                        canvas and deploys with your next apply.
                    </DialogDescription>
                </div>
            </div>
        </DialogHeader>
        <DialogPanel>
            <form
                id="canvas-template-form"
                class="space-y-4"
                onsubmit={(event) => {
                    event.preventDefault();

                    if (ready && !pending) onsubmit({ ...variables });
                }}
            >
                {#if error}
                    <Alert variant="error">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                {/if}
                {#each version?.required ?? [] as key, index (key)}
                    <Field>
                        <Label
                            for="canvas-template-{key}"
                            required
                            class="font-mono"
                        >
                            {key}
                        </Label>
                        <Input
                            id="canvas-template-{key}"
                            bind:value={
                                () => variables[key] ?? "",
                                (value) => (variables[key] = value)
                            }
                            autofocus={index === 0}
                            autocomplete="off"
                            spellcheck={false}
                            maxlength={4096}
                            class="font-mono"
                            disabled={pending}
                        />
                    </Field>
                {/each}
                {#if version && version.secrets.length > 0}
                    <p
                        class="flex items-center gap-1.5 text-xs text-muted-foreground"
                    >
                        <KeyRound
                            class="size-3.5"
                            aria-hidden="true"
                        />
                        {version.secrets.length}
                        {version.secrets.length === 1
                            ? "secret is"
                            : "secrets are"} generated for you.
                    </p>
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
                form="canvas-template-form"
                loading={pending}
                disabled={!ready}
            >
                Add to canvas
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
