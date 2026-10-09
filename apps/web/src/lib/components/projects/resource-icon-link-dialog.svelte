<script lang="ts">
    import {
        Avatar,
        AvatarFallback,
        AvatarImage,
    } from "$lib/components/ui/avatar";
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
    import { Field, FieldError } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import Boxes from "@lucide/svelte/icons/boxes";
    import { watch } from "runed";

    let {
        open = $bindable(false),
        currentIcon,
        onselect,
    }: {
        open?: boolean;
        currentIcon: string;
        onselect: (icon: string) => void;
    } = $props();

    let linkDraft = $state("");

    let linkError = $state("");

    const isLinkValid = $derived.by(() => {
        const value = linkDraft.trim();

        if (!value) return false;

        try {
            const url = new URL(value);

            return (
                url.protocol === "http:" || url.protocol === "https:"
            );
        } catch {
            return false;
        }
    });

    // Start from the current icon unless it is an uploaded data URL.
    watch(
        () => open,
        (isOpen) => {
            if (!isOpen) return;
            linkError = "";
            const current = currentIcon.trim();
            linkDraft =
                current && !current.startsWith("data:")
                    ? current
                    : "";
        },
    );

    function confirmLink() {
        const value = linkDraft.trim();

        if (!value) {
            linkError = "Paste an image URL.";

            return;
        }

        try {
            const url = new URL(value);

            if (
                url.protocol !== "http:" &&
                url.protocol !== "https:"
            ) {
                linkError =
                    "Link must start with http:// or https://.";

                return;
            }
        } catch {
            linkError = "That doesn't look like a valid URL.";

            return;
        }

        linkError = "";
        onselect(value);
        open = false;
    }
</script>

<Dialog bind:open>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Use icon link</DialogTitle>
            <DialogDescription>
                Paste a direct link to an image. It will be shown in
                the resource list.
            </DialogDescription>
        </DialogHeader>
        <DialogPanel>
            <div class="space-y-4">
                <div class="flex items-center gap-3">
                    <Avatar
                        class="size-14 shrink-0 rounded-xl border border-border bg-transparent"
                    >
                        {#if linkDraft.trim() && isLinkValid}
                            <AvatarImage
                                src={linkDraft.trim()}
                                alt=""
                                class="object-contain"
                                onLoadingStatusChange={(status) => {
                                    linkError =
                                        status === "error"
                                            ? "Unable to load a preview for that URL."
                                            : "";
                                }}
                            />
                        {/if}
                        <AvatarFallback
                            class="rounded-none bg-muted/50"
                        >
                            <Boxes
                                class="size-5 text-muted-foreground"
                                aria-hidden="true"
                            />
                        </AvatarFallback>
                    </Avatar>
                    <Field class="min-w-0 flex-1">
                        <Label for="icon-link-url">Image URL</Label>
                        <Input
                            id="icon-link-url"
                            type="url"
                            bind:value={linkDraft}
                            placeholder="https://example.com/icon.png"
                            maxlength={2048}
                            aria-invalid={Boolean(linkError)}
                            oninput={() => (linkError = "")}
                        />
                        {#if linkError}<FieldError>
                                {linkError}
                            </FieldError>{/if}
                    </Field>
                </div>
            </div>
        </DialogPanel>
        <DialogFooter>
            <Button variant="outline" onclick={() => (open = false)}>
                Cancel
            </Button>
            <Button disabled={!isLinkValid} onclick={confirmLink}>
                Use icon
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
