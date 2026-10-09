<script lang="ts">
    import ResourceIconLinkDialog from "./resource-icon-link-dialog.svelte";
    import ResourceIconUploadDialog from "./resource-icon-upload-dialog.svelte";
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
        Card,
        CardFooter,
        CardPanel,
    } from "$lib/components/ui/card";
    import { Field, FieldError } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuSeparator,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import { Textarea } from "$lib/components/ui/textarea";
    import { orpc, queryClient } from "$lib/api/orpc";
    import { cn } from "$lib/utils";
    import Boxes from "@lucide/svelte/icons/boxes";
    import Link from "@lucide/svelte/icons/link";
    import Pencil from "@lucide/svelte/icons/pencil";
    import Trash2 from "@lucide/svelte/icons/trash-2";
    import Upload from "@lucide/svelte/icons/upload";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import {
        parseAsBoolean,
        parseAsStringLiteral,
        useQueryStates,
    } from "nuqs-svelte";
    import { untrack } from "svelte";
    import { watch } from "runed";

    let {
        projectId,
        resourceId,
    }: {
        projectId: string;
        resourceId: string;
    } = $props();

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({
            input: { projectId, resourceId },
        }),
    );

    const view = useQueryStates(
        {
            iconMenu: parseAsBoolean.withDefault(false),
            iconDialog: parseAsStringLiteral(["upload", "link"]),
        },
        { shallow: true, scroll: false },
    );

    let loadedResourceId = $state("");

    let detailName = $state("");

    let detailDescription = $state("");

    let detailIcon = $state("");

    let savedDetailName = $state("");

    let savedDetailDescription = $state("");

    let savedDetailIcon = $state("");

    let iconLoadFailed = $state(false);

    const isDetailsDirty = $derived(
        detailName !== savedDetailName ||
            detailDescription !== savedDetailDescription ||
            detailIcon !== savedDetailIcon,
    );

    const isDetailsValid = $derived(detailName.trim().length > 0);

    const iconPreview = $derived(detailIcon.trim());

    const iconMenuOpen = $derived(view.iconMenu.current);

    const uploadOpen = $derived(view.iconDialog.current === "upload");

    const linkOpen = $derived(view.iconDialog.current === "link");

    function openIconDialog(dialog: "upload" | "link") {
        void view.set({ iconMenu: false, iconDialog: dialog });
    }

    function removeIcon() {
        void view.set({ iconMenu: false });
        detailIcon = "";
        iconLoadFailed = false;
    }

    function selectIcon(icon: string) {
        detailIcon = icon;
        iconLoadFailed = false;
    }

    const detailsMutation = createMutation(() =>
        orpc.resources.updateDetails.mutationOptions({
            onSuccess: (updated, input) => {
                if (loadedResourceId === updated.id) {
                    savedDetailName = updated.name ?? "";
                    savedDetailDescription =
                        updated.description ?? "";
                    savedDetailIcon = updated.icon ?? "";
                    detailName = savedDetailName;
                    detailDescription = savedDetailDescription;
                    detailIcon = savedDetailIcon;
                }

                queryClient.setQueryData(
                    orpc.resources.getResource.queryKey({
                        input: {
                            projectId: input.projectId,
                            resourceId: input.resourceId,
                        },
                    }),
                    updated,
                );
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.queryKey({
                        input: { projectId: input.projectId },
                    }),
                });
            },
        }),
    );

    $effect(() => {
        const current = resourceQuery.data;

        if (!current) return;
        untrack(() => {
            if (loadedResourceId !== current.id) {
                loadedResourceId = current.id;
                savedDetailName = current.name ?? "";
                savedDetailDescription = current.description ?? "";
                savedDetailIcon = current.icon ?? "";
                detailName = savedDetailName;
                detailDescription = savedDetailDescription;
                detailIcon = savedDetailIcon;
                iconLoadFailed = false;
                detailsMutation.reset();
            } else if (!isDetailsDirty) {
                savedDetailName = current.name ?? "";
                savedDetailDescription = current.description ?? "";
                savedDetailIcon = current.icon ?? "";
                detailName = savedDetailName;
                detailDescription = savedDetailDescription;
                detailIcon = savedDetailIcon;
            }
        });
    });

    // Reset before Avatar's preloader can report a cached failure for the new source.
    watch.pre(
        () => iconPreview,
        () => {
            iconLoadFailed = false;
        },
    );

    function saveDetails() {
        if (
            !isDetailsDirty ||
            !isDetailsValid ||
            detailsMutation.isPending
        )
            return;
        detailsMutation.mutate({
            projectId,
            resourceId,
            name: detailName.trim(),
            description: detailDescription.trim() || undefined,
            icon: detailIcon.trim() || undefined,
        });
    }

    function resetDetails() {
        detailName = savedDetailName;
        detailDescription = savedDetailDescription;
        detailIcon = savedDetailIcon;
        iconLoadFailed = false;
        detailsMutation.reset();
    }
</script>

<section
    class="grid gap-5 md:grid-cols-3 md:gap-8"
    aria-labelledby="general-settings-heading"
>
    <div>
        <h2
            id="general-settings-heading"
            class="text-lg font-semibold leading-tight tracking-tight"
        >
            General
        </h2>
        <p class="mt-1 text-sm leading-relaxed text-muted-foreground">
            Update the name, description, and icon for this resource.
        </p>
    </div>

    <div class="md:col-span-2">
        <Card>
            <CardPanel class="space-y-5 p-5 sm:p-6">
                <div class="flex items-end gap-4">
                    <Menu
                        bind:open={
                            () => iconMenuOpen,
                            (open) =>
                                void view.set({
                                    iconMenu: open,
                                })
                        }
                    >
                        <MenuTrigger
                            aria-label={iconPreview
                                ? "Change icon"
                                : "Add icon"}
                            disabled={detailsMutation.isPending}
                            class={cn(
                                "group relative flex size-16 shrink-0 items-center justify-center rounded-xl border bg-muted/40 outline-none transition-colors",
                                "hover:border-ring focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card",
                                "disabled:pointer-events-none disabled:opacity-50",
                                iconPreview && !iconLoadFailed
                                    ? "border-border"
                                    : "border-dashed border-border",
                            )}
                        >
                            <Avatar
                                class="size-full rounded-[calc(var(--radius-xl)-1px)] bg-transparent"
                            >
                                {#if iconPreview && !iconLoadFailed}
                                    <AvatarImage
                                        src={iconPreview}
                                        alt=""
                                        class="object-contain"
                                        onLoadingStatusChange={(
                                            status,
                                        ) => {
                                            const source =
                                                iconPreview;
                                            // Let Avatar finish mounting before a cached error removes it.
                                            queueMicrotask(() => {
                                                if (
                                                    source ===
                                                    iconPreview
                                                )
                                                    iconLoadFailed =
                                                        status ===
                                                        "error";
                                            });
                                        }}
                                    />
                                {/if}
                                <AvatarFallback
                                    class="rounded-none bg-transparent"
                                >
                                    <Boxes
                                        class="size-6 text-muted-foreground"
                                        aria-hidden="true"
                                    />
                                </AvatarFallback>
                            </Avatar>
                            <span
                                class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[calc(var(--radius-xl)-1px)] bg-background/70 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[popup-open]:opacity-100"
                                aria-hidden="true"
                            >
                                <Pencil class="size-4" />
                            </span>
                        </MenuTrigger>
                        <MenuPopup align="start" class="min-w-44">
                            <MenuItem
                                onclick={() =>
                                    openIconDialog("upload")}
                            >
                                <Upload aria-hidden="true" />
                                Upload image
                            </MenuItem>
                            <MenuItem
                                onclick={() => openIconDialog("link")}
                            >
                                <Link aria-hidden="true" />
                                Use link
                            </MenuItem>
                            {#if iconPreview}
                                <MenuSeparator />
                                <MenuItem
                                    variant="destructive"
                                    onclick={removeIcon}
                                >
                                    <Trash2 aria-hidden="true" />
                                    Remove icon
                                </MenuItem>
                            {/if}
                        </MenuPopup>
                    </Menu>
                    <Field class="min-w-0 flex-1">
                        <Label for="resource-name" required>
                            Name
                        </Label>
                        <Input
                            id="resource-name"
                            bind:value={detailName}
                            placeholder="My service"
                            required
                            maxlength={100}
                            disabled={detailsMutation.isPending}
                            aria-invalid={!isDetailsValid}
                        />
                        {#if !isDetailsValid}<FieldError>
                                Name is required.
                            </FieldError>{/if}
                    </Field>
                </div>
                <Field>
                    <Label for="resource-description">
                        Description
                    </Label>
                    <Textarea
                        id="resource-description"
                        bind:value={detailDescription}
                        placeholder="What is this resource for?"
                        maxlength={500}
                        rows={3}
                        disabled={detailsMutation.isPending}
                    />
                </Field>
                {#if detailsMutation.isError}
                    <Alert variant="error">
                        <AlertDescription>
                            Unable to save: {detailsMutation.error
                                .message}
                        </AlertDescription>
                    </Alert>
                {/if}
            </CardPanel>
            <CardFooter
                class="flex-wrap justify-between gap-4 border-t px-5 py-4 sm:px-6"
            >
                <p
                    class="min-w-0 truncate text-sm text-muted-foreground"
                    aria-live="polite"
                >
                    {#if detailsMutation.isPending}
                        Saving…
                    {:else if isDetailsDirty}
                        Unsaved changes
                    {:else if detailsMutation.isSuccess}
                        Saved.
                    {/if}
                </p>
                <div class="flex shrink-0 items-center gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        disabled={!isDetailsDirty ||
                            detailsMutation.isPending}
                        onclick={resetDetails}
                    >
                        Reset
                    </Button>
                    <Button
                        size="sm"
                        loading={detailsMutation.isPending}
                        disabled={!isDetailsDirty ||
                            !isDetailsValid ||
                            detailsMutation.isPending}
                        onclick={saveDetails}
                    >
                        {detailsMutation.isPending
                            ? "Saving…"
                            : "Save changes"}
                    </Button>
                </div>
            </CardFooter>
        </Card>
    </div>
</section>

<ResourceIconUploadDialog
    bind:open={
        () => uploadOpen,
        (open) => {
            if (!open) void view.set({ iconDialog: null });
        }
    }
    onselect={selectIcon}
/>
<ResourceIconLinkDialog
    bind:open={
        () => linkOpen,
        (open) => {
            if (!open) void view.set({ iconDialog: null });
        }
    }
    currentIcon={detailIcon}
    onselect={selectIcon}
/>
