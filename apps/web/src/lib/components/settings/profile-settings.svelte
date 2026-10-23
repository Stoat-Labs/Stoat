<script lang="ts">
    import { Card, CardPanel } from "$lib/components/ui/card";
    import { invalidateAll } from "$app/navigation";
    import { authClient } from "$lib/api/auth-client";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import {
        Avatar,
        AvatarFallback,
        AvatarImage,
    } from "$lib/components/ui/avatar";
    import { Button } from "$lib/components/ui/button";
    import { Field } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { onMount } from "svelte";
    import SettingsSection from "./settings-section.svelte";

    let {
        user,
    }: {
        user: { name: string; email: string; image?: string | null };
    } = $props();

    let name = $state("");

    let ready = $state(false);

    let pending = $state(false);

    let error = $state("");

    let saved = $state(false);

    onMount(() => {
        name = user.name;
        ready = true;
    });

    async function save(event: SubmitEvent) {
        event.preventDefault();

        if (pending) return;
        pending = true;
        error = "";
        saved = false;

        try {
            const result = await authClient.updateUser({
                name: name.trim(),
            });

            if (result.error) {
                error =
                    result.error.message ??
                    "Unable to update your profile.";

                return;
            }

            await invalidateAll();
            saved = true;
        } catch {
            error = "Unable to save your profile. Try again.";
        } finally {
            pending = false;
        }
    }

    const AVATAR_SIZE = 128;

    const initials = $derived(
        user.name.trim().slice(0, 2).toUpperCase() ||
            user.email.slice(0, 2).toUpperCase(),
    );

    let fileInput = $state<HTMLInputElement>();

    let imagePending = $state(false);

    let imageError = $state("");

    // Center-crops to a square and stores it inline as a small WebP data URL,
    // since Stoat has no file storage.
    async function resizeImage(file: File) {
        const bitmap = await createImageBitmap(file);
        const side = Math.min(bitmap.width, bitmap.height);
        const canvas = document.createElement("canvas");
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const context = canvas.getContext("2d");

        if (!context) throw new Error("Canvas is unavailable.");
        context.drawImage(
            bitmap,
            (bitmap.width - side) / 2,
            (bitmap.height - side) / 2,
            side,
            side,
            0,
            0,
            AVATAR_SIZE,
            AVATAR_SIZE,
        );
        bitmap.close();

        return canvas.toDataURL("image/webp", 0.85);
    }

    async function saveImage(file: File | null) {
        if (imagePending) return;
        imagePending = true;
        imageError = "";

        try {
            const result = await authClient.updateUser({
                image: file ? await resizeImage(file) : null,
            });

            if (result.error) {
                imageError =
                    result.error.message ??
                    "Unable to update your picture.";

                return;
            }

            await invalidateAll();
        } catch {
            imageError =
                "Unable to use that image. Try another file.";
        } finally {
            imagePending = false;
        }
    }

    function pickImage(
        event: Event & { currentTarget: HTMLInputElement },
    ) {
        const file = event.currentTarget.files?.[0];
        // Clear it so picking the same file again still fires change.
        event.currentTarget.value = "";

        if (file) void saveImage(file);
    }
</script>

<SettingsSection
    title="Profile"
    description="Your name and picture appear in your organizations."
>
    <Card>
        <CardPanel class="space-y-5 p-5 sm:p-6">
            <div class="flex items-center gap-4">
                <Avatar class="size-16">
                    {#if user.image}<AvatarImage
                            src={user.image}
                            alt=""
                        />{/if}
                    <AvatarFallback class="text-lg">
                        {initials}
                    </AvatarFallback>
                </Avatar>
                <div class="min-w-0 space-y-2">
                    <div class="flex flex-wrap gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={!ready}
                            loading={imagePending}
                            onclick={() => fileInput?.click()}
                        >
                            Upload picture
                        </Button>
                        {#if user.image}
                            <Button
                                variant="ghost"
                                size="sm"
                                disabled={!ready || imagePending}
                                onclick={() => saveImage(null)}
                            >
                                Remove
                            </Button>
                        {/if}
                    </div>
                    <p class="text-xs text-muted-foreground">
                        Cropped to a square.
                    </p>
                </div>
                <input
                    bind:this={fileInput}
                    type="file"
                    accept="image/*"
                    class="hidden"
                    aria-label="Profile picture"
                    onchange={pickImage}
                />
            </div>
            {#if imageError}
                <Alert variant="error">
                    <AlertDescription>{imageError}</AlertDescription>
                </Alert>
            {/if}
            <form
                onsubmit={save}
                class="space-y-4"
                aria-busy={pending}
            >
                <Field>
                    <Label for="profile-name">Full name</Label>
                    <Input
                        id="profile-name"
                        autocomplete="name"
                        bind:value={name}
                        required
                        maxlength={100}
                        pattern=".*\S.*"
                        disabled={!ready || pending}
                    />
                </Field>
                <Field>
                    <Label for="profile-email">Email</Label>
                    <Input
                        id="profile-email"
                        type="email"
                        value={user.email}
                        readonly
                    />
                </Field>
                {#if error}
                    <Alert variant="error">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                {/if}
                {#if saved}
                    <Alert variant="success" role="status">
                        <AlertDescription>
                            Profile updated.
                        </AlertDescription>
                    </Alert>
                {/if}
                <Button
                    type="submit"
                    disabled={!ready || name.trim() === user.name}
                    loading={pending}
                >
                    Save changes
                </Button>
            </form>
        </CardPanel>
    </Card>
</SettingsSection>
