<script lang="ts">
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
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import { Input } from "$lib/components/ui/input";
    import Boxes from "@lucide/svelte/icons/boxes";
    import Upload from "@lucide/svelte/icons/upload";
    import { watch } from "runed";

    let {
        open = $bindable(false),
        onselect,
    }: {
        open?: boolean;
        onselect: (icon: string) => void;
    } = $props();

    const SVG_MAX_BYTES = 256 * 1024;

    let uploadPreview = $state("");

    let uploadError = $state("");

    let uploadProcessing = $state(false);

    let uploadFileName = $state("");

    let fileInput: HTMLInputElement | null = $state(null);

    watch(
        () => open,
        (isOpen) => {
            if (!isOpen) return;
            uploadError = "";
            uploadPreview = "";
            uploadFileName = "";
            uploadProcessing = false;
        },
    );

    function isSvgFile(file: File): boolean {
        return (
            file.type === "image/svg+xml" || /\.svg$/i.test(file.name)
        );
    }

    function fileToDataUrl(file: File): Promise<string> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () =>
                reject(
                    reader.error ?? new Error("Unable to read file."),
                );
            reader.readAsDataURL(file);
        });
    }

    async function svgToDataUrl(file: File): Promise<string> {
        const text = await file.text();

        if (!/<svg[\s>]/i.test(text))
            throw new Error("Not an SVG document.");

        return `data:image/svg+xml;base64,${(await fileToDataUrl(file)).split(",", 2)[1] ?? ""}`;
    }

    async function fileToResizedDataUrl(file: File): Promise<string> {
        const bitmap = await createImageBitmap(file);

        try {
            const max = 256;

            const scale = Math.min(
                1,
                max / Math.max(bitmap.width, bitmap.height),
            );

            const w = Math.max(1, Math.round(bitmap.width * scale));
            const h = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");

            if (!ctx) throw new Error("Canvas is not supported.");
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(bitmap, 0, 0, w, h);

            return canvas.toDataURL("image/png");
        } finally {
            bitmap.close();
        }
    }

    async function handleFileChange(event: Event) {
        const input = event.currentTarget;

        if (!(input instanceof HTMLInputElement)) return;
        const file = input.files?.[0];

        if (!file) return;
        uploadError = "";
        uploadPreview = "";
        uploadFileName = file.name;
        const svg = isSvgFile(file);

        if (!svg && !file.type.startsWith("image/")) {
            uploadError = "Please choose an image file.";
            input.value = "";

            return;
        }

        if (svg && file.size > SVG_MAX_BYTES) {
            uploadError = "SVG must be 256 KB or smaller.";
            input.value = "";

            return;
        }

        if (!svg && file.size > 5 * 1024 * 1024) {
            uploadError = "Image must be 5 MB or smaller.";
            input.value = "";

            return;
        }

        uploadProcessing = true;

        try {
            uploadPreview = svg
                ? await svgToDataUrl(file)
                : await fileToResizedDataUrl(file);
        } catch {
            uploadError =
                "Unable to read that image. Try another file.";
        } finally {
            uploadProcessing = false;
            input.value = "";
        }
    }

    function confirmUpload() {
        if (!uploadPreview || uploadProcessing) return;
        onselect(uploadPreview);
        open = false;
    }
</script>

<Dialog bind:open>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Upload icon</DialogTitle>
            <DialogDescription>
                Choose an image. Raster images are resized to 256px;
                SVGs are stored as-is.
            </DialogDescription>
        </DialogHeader>
        <DialogPanel>
            <div class="space-y-4">
                <div class="flex items-center gap-4">
                    <Avatar
                        class="size-14 shrink-0 rounded-xl border border-border bg-transparent"
                    >
                        {#if uploadPreview}<AvatarImage
                                src={uploadPreview}
                                alt=""
                                class="object-contain"
                            />{/if}
                        <AvatarFallback
                            class="rounded-none bg-muted/50"
                        >
                            <Boxes
                                class="size-5 text-muted-foreground"
                                aria-hidden="true"
                            />
                        </AvatarFallback>
                    </Avatar>
                    <div class="min-w-0 flex-1 space-y-1">
                        <p class="truncate text-sm font-medium">
                            {uploadFileName || "No file chosen"}
                        </p>
                        <p class="text-sm text-muted-foreground">
                            PNG, JPEG, GIF, or WebP up to 5 MB. SVG up
                            to 256 KB.
                        </p>
                    </div>
                </div>
                <Input
                    bind:ref={fileInput}
                    type="file"
                    accept="image/*,.svg"
                    class="sr-only"
                    aria-label="Choose an image file"
                    onchange={handleFileChange}
                />
                <Button
                    variant="outline"
                    size="sm"
                    loading={uploadProcessing}
                    onclick={() => fileInput?.click()}
                >
                    <Upload class="size-4" aria-hidden="true" />
                    {uploadProcessing ? "Reading…" : "Choose file"}
                </Button>
                {#if uploadError}
                    <Alert variant="error">
                        <AlertDescription>
                            {uploadError}
                        </AlertDescription>
                    </Alert>
                {/if}
            </div>
        </DialogPanel>
        <DialogFooter>
            <Button variant="outline" onclick={() => (open = false)}>
                Cancel
            </Button>
            <Button
                disabled={!uploadPreview || uploadProcessing}
                onclick={confirmUpload}
            >
                Use icon
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
