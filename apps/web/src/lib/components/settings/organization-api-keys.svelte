<script lang="ts">
    import { authClient } from "$lib/api/auth-client";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import {
        Button,
        buttonVariants,
    } from "$lib/components/ui/button";
    import { Field } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { createQuery } from "@tanstack/svelte-query";
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
        Empty,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import { Separator } from "$lib/components/ui/separator";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import Ellipsis from "@lucide/svelte/icons/ellipsis";
    import KeyRound from "@lucide/svelte/icons/key-round";
    import Plus from "@lucide/svelte/icons/plus";
    import Trash2 from "@lucide/svelte/icons/trash-2";
    import ConfirmDialog from "./confirm-dialog.svelte";
    import SettingsSection from "./settings-section.svelte";

    let {
        organization,
    }: { organization: { id: string; name: string } } = $props();

    const keysQuery = createQuery(() => ({
        queryKey: ["api-keys", organization.id],
        queryFn: async () => {
            const result = await authClient.apiKey.list({
                query: { organizationId: organization.id },
            });

            if (result.error)
                throw new Error(
                    result.error.message ??
                        "Unable to load API keys.",
                );

            return result.data.apiKeys;
        },
    }));

    let createOpen = $state(false);

    let keyName = $state("");

    let createdKey = $state("");

    let pending = $state(false);

    let createError = $state("");

    let actionError = $state("");

    function openCreate() {
        keyName = "";
        createdKey = "";
        createError = "";
        createOpen = true;
    }

    const error = $derived(keysQuery.error?.message ?? actionError);

    async function createKey(event: SubmitEvent) {
        event.preventDefault();

        if (pending) return;
        pending = true;
        createError = "";

        try {
            const result = await authClient.apiKey.create({
                name: keyName.trim(),
                organizationId: organization.id,
            });

            if (result.error) {
                createError =
                    result.error.message ??
                    "Unable to create the API key.";

                return;
            }

            createdKey = result.data.key;
            await keysQuery.refetch();
        } finally {
            pending = false;
        }
    }

    let deleteId = $state("");

    let deleteOpen = $state(false);

    let deleting = $state(false);

    let deleteError = $state("");

    function askDelete(keyId: string) {
        deleteId = keyId;
        deleteError = "";
        deleteOpen = true;
    }

    async function deleteKey() {
        if (deleting) return;
        deleting = true;
        deleteError = "";

        try {
            const result = await authClient.apiKey.delete({
                keyId: deleteId,
            });

            if (result.error) {
                deleteError =
                    result.error.message ??
                    "Unable to delete the API key.";

                return;
            }

            deleteOpen = false;
            await keysQuery.refetch();
        } finally {
            deleting = false;
        }
    }
</script>

<SettingsSection
    title="API keys"
    description="Keys let scripts and CI call the Stoat API for {organization.name}."
    count={keysQuery.data
        ? `${keysQuery.data.length} ${keysQuery.data.length === 1 ? "key" : "keys"}`
        : undefined}
    panelClass="p-0"
>
    {#snippet actions()}
        <Button
            variant="outline"
            href="/api-reference"
            target="_blank"
            rel="noreferrer"
        >
            API docs
        </Button>
        <Button onclick={openCreate}>
            <Plus class="size-4" aria-hidden="true" />
            Create key
        </Button>
    {/snippet}
    {#if error}
        <Alert variant="error" class="m-3 w-auto">
            <AlertDescription>{error}</AlertDescription>
        </Alert>
    {/if}
    {#if keysQuery.isPending}
        <Skeleton
            loading
            count={2}
            count-gap={1}
            loading-label="Loading API keys"
        >
            <div
                class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 p-3"
            >
                <span
                    class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                >
                    <KeyRound class="size-5" aria-hidden="true" />
                </span>
                <div class="min-w-0">
                    <h3
                        class="truncate text-sm font-medium leading-5"
                    >
                        CI deploys
                    </h3>
                    <p
                        class="mt-1 truncate text-xs leading-5 text-muted-foreground"
                    >
                        stoat_abc… &middot; Created 1/1/2026
                    </p>
                </div>
                <span class="size-8 sm:size-7"></span>
            </div>
        </Skeleton>
    {:else if keysQuery.data?.length}
        <ul>
            {#each keysQuery.data as key, index (key.id)}
                <li class="min-w-0">
                    {#if index > 0}<Separator />{/if}
                    <div
                        class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 p-3"
                    >
                        <span
                            class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                        >
                            <KeyRound
                                class="size-5"
                                aria-hidden="true"
                            />
                        </span>
                        <div class="min-w-0">
                            <h3
                                class="truncate text-sm font-medium leading-5"
                                title={key.name ?? "Unnamed key"}
                            >
                                {key.name ?? "Unnamed key"}
                            </h3>
                            <p
                                class="mt-1 truncate text-xs leading-5 text-muted-foreground"
                            >
                                <span class="font-mono">
                                    {key.start}…
                                </span>
                                &middot; Created {new Date(
                                    key.createdAt,
                                ).toLocaleDateString()}
                            </p>
                        </div>
                        <Menu>
                            <MenuTrigger
                                class={buttonVariants({
                                    variant: "ghost",
                                    size: "icon-sm",
                                })}
                                aria-label={`Actions for ${key.name ?? "unnamed key"}`}
                            >
                                <Ellipsis
                                    class="size-4"
                                    aria-hidden="true"
                                />
                            </MenuTrigger>
                            <MenuPopup align="end">
                                <MenuItem
                                    variant="destructive"
                                    onclick={() => askDelete(key.id)}
                                >
                                    <Trash2 aria-hidden="true" />
                                    Delete
                                </MenuItem>
                            </MenuPopup>
                        </Menu>
                    </div>
                </li>
            {/each}
        </ul>
    {:else if keysQuery.isSuccess}
        <Empty
            class="m-3 rounded-xl border border-dashed border-border p-4 md:py-6"
        >
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <KeyRound aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No API keys yet</EmptyTitle>
                <EmptyDescription>
                    Create a key to call the Stoat API from scripts
                    and CI.
                </EmptyDescription>
            </EmptyHeader>
        </Empty>
    {/if}
</SettingsSection>

<Dialog bind:open={createOpen}>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>
                {createdKey ? "API key created" : "Create API key"}
            </DialogTitle>
            <DialogDescription>
                {createdKey
                    ? "Copy this key now; it won't be shown again."
                    : `Send it as the x-api-key header. It has admin access to ${organization.name}.`}
            </DialogDescription>
        </DialogHeader>
        {#if createdKey}
            <DialogPanel>
                <code class="block break-all select-all">
                    {createdKey}
                </code>
            </DialogPanel>
            <DialogFooter>
                <Button onclick={() => (createOpen = false)}>
                    Done
                </Button>
            </DialogFooter>
        {:else}
            <form
                class="contents"
                onsubmit={createKey}
                aria-busy={pending}
            >
                <DialogPanel class="space-y-4">
                    <Field>
                        <Label for="api-key-name">Name</Label>
                        <Input
                            id="api-key-name"
                            bind:value={keyName}
                            required
                            maxlength={32}
                            pattern=".*\S.*"
                            placeholder="CI deploys"
                            disabled={pending}
                        />
                    </Field>
                    {#if createError}
                        <Alert variant="error">
                            <AlertDescription>
                                {createError}
                            </AlertDescription>
                        </Alert>
                    {/if}
                </DialogPanel>
                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={pending}
                        onclick={() => (createOpen = false)}
                    >
                        Cancel
                    </Button>
                    <Button type="submit" loading={pending}>
                        Create key
                    </Button>
                </DialogFooter>
            </form>
        {/if}
    </DialogContent>
</Dialog>

<ConfirmDialog
    bind:open={deleteOpen}
    title="Delete API key?"
    description="Anything using this key will stop working."
    confirmLabel="Delete"
    pending={deleting}
    error={deleteError}
    onconfirm={deleteKey}
/>
