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
    import {
        type Area,
        Cropper,
        CropperCropArea,
        CropperDescription,
        CropperImage,
    } from "$lib/components/ui/cropper";
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
    import { Slider } from "$lib/components/ui/slider";
    import { onDestroy, onMount } from "svelte";
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

    let cropFile = $state<File | null>(null);

    let cropUrl = $state("");

    let cropArea = $state<Area | null>(null);

    let zoom = $state(1);

    // Stores the crop inline as a small WebP data URL, since Stoat has no file storage.
    async function resizeImage(file: File, area: Area) {
        const bitmap = await createImageBitmap(file);
        const canvas = document.createElement("canvas");
        canvas.width = AVATAR_SIZE;
        canvas.height = AVATAR_SIZE;
        const context = canvas.getContext("2d");

        if (!context) throw new Error("Canvas is unavailable.");
        context.drawImage(
            bitmap,
            area.x,
            area.y,
            area.width,
            area.height,
            0,
            0,
            AVATAR_SIZE,
            AVATAR_SIZE,
        );
        bitmap.close();

        return canvas.toDataURL("image/webp", 0.85);
    }

    async function saveImage(image: Promise<string> | null) {
        if (imagePending) return;
        imagePending = true;
        imageError = "";

        try {
            const result = await authClient.updateUser({
                image: image ? await image : null,
            });

            if (result.error) {
                imageError =
                    result.error.message ??
                    "Unable to update your picture.";

                return;
            }

            await invalidateAll();
            closeCrop();
        } catch {
            imageError =
                "Unable to use that image. Try another file.";
        } finally {
            imagePending = false;
        }
    }

    async function pickImage(
        event: Event & { currentTarget: HTMLInputElement },
    ) {
        const file = event.currentTarget.files?.[0];
        // Clear it so picking the same file again still fires change.
        event.currentTarget.value = "";

        if (!file) return;
        imageError = "";

        // Decode up front: the cropper gives no signal when an image fails to load.
        try {
            (await createImageBitmap(file)).close();
        } catch {
            imageError =
                "Unable to use that image. Try another file.";

            return;
        }

        zoom = 1;
        cropArea = null;
        cropFile = file;
        cropUrl = URL.createObjectURL(file);
    }

    function closeCrop() {
        if (cropUrl) URL.revokeObjectURL(cropUrl);
        cropFile = null;
        cropUrl = "";
    }

    // Leaving settings with the dialog open would otherwise keep the file in memory.
    onDestroy(closeCrop);

    function applyCrop() {
        if (cropFile && cropArea)
            void saveImage(resizeImage(cropFile, cropArea));
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
                        You can crop it after choosing.
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
            {#if imageError && !cropFile}
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

<Dialog
    bind:open={
        () => cropFile !== null,
        (open) => {
            if (!open && !imagePending) closeCrop();
        }
    }
>
    <DialogContent class="sm:max-w-md">
        <DialogHeader>
            <DialogTitle>Crop picture</DialogTitle>
        </DialogHeader>
        <DialogPanel class="space-y-4">
            <Cropper
                class="h-72 rounded-lg"
                image={cropUrl}
                bind:zoom
                onCropChange={(area) => (cropArea = area)}
            >
                <CropperDescription />
                <CropperImage />
                <CropperCropArea class="rounded-full" />
            </Cropper>
            <Slider
                min={1}
                max={3}
                step={0.1}
                bind:value={zoom}
                aria-label="Zoom"
            />
            {#if imageError}
                <Alert variant="error">
                    <AlertDescription>{imageError}</AlertDescription>
                </Alert>
            {/if}
        </DialogPanel>
        <DialogFooter>
            <Button
                variant="outline"
                disabled={imagePending}
                onclick={closeCrop}
            >
                Cancel
            </Button>
            <Button
                loading={imagePending}
                disabled={!cropArea}
                onclick={applyCrop}
            >
                Apply
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
