<script lang="ts">
    import { goto } from "$app/navigation";
    import ConnectionFields from "$lib/components/s3/connection-fields.svelte";
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
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { orpc, queryClient } from "$lib/api/orpc";
    import {
        s3ConnectionInput,
        s3DraftComplete,
        type S3ConnectionDraft,
    } from "$lib/s3";
    import {
        isS3ProviderId,
        S3_PROVIDER_IDS,
        s3Providers,
        type S3ProviderId,
    } from "@stoat/s3/providers";
    import { createMutation } from "@tanstack/svelte-query";
    import { watch } from "runed";

    let { open = $bindable(false) }: { open?: boolean } = $props();

    let provider = $state<S3ProviderId>("rustfs");

    let name = $state("");

    // Secrets live here, never in the URL.
    let draft = $state<S3ConnectionDraft>(emptyDraft());

    const providerItems = S3_PROVIDER_IDS.map((id) => ({
        value: id,
        label: s3Providers[id].name,
    }));

    function emptyDraft(): S3ConnectionDraft {
        return {
            endpoint: "",
            region: "us-east-1",
            forcePathStyle: false,
            accountId: "",
            accessKey: "",
            secretKey: "",
            apiToken: "",
        };
    }

    watch(
        () => open,
        (isOpen, wasOpen) => {
            if (!isOpen || wasOpen === true) return;

            provider = "rustfs";
            name = "";
            draft = emptyDraft();
            createState.reset();
            testState.reset();
        },
    );

    const createState = createMutation(() =>
        orpc.s3.create.mutationOptions({
            onSuccess: async (connection) => {
                await queryClient.invalidateQueries({
                    queryKey: orpc.s3.list.queryKey(),
                });
                open = false;
                await goto(`/s3/${connection.id}`);
            },
        }),
    );

    const testState = createMutation(() =>
        orpc.s3.test.mutationOptions(),
    );

    const pending = $derived(
        createState.isPending || testState.isPending,
    );

    const complete = $derived(s3DraftComplete(provider, draft, true));

    function selectProvider(value: string | null) {
        if (!value || !isS3ProviderId(value)) return;

        provider = value;
        testState.reset();
    }

    function create(event: SubmitEvent) {
        event.preventDefault();

        if (!complete || !name.trim() || pending) return;

        testState.reset();
        createState.mutate({
            name: name.trim(),
            connection: s3ConnectionInput(provider, draft),
        });
    }

    function test() {
        if (!complete || pending) return;

        createState.reset();
        testState.mutate({
            connection: s3ConnectionInput(provider, draft),
        });
    }
</script>

<Dialog bind:open>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>Add S3 connection</DialogTitle>
            <DialogDescription>
                A provider account that projects provision buckets
                from.
            </DialogDescription>
        </DialogHeader>
        <DialogPanel>
            {#if createState.isError}
                <Alert variant="error" class="mb-4" role="alert">
                    <AlertDescription>
                        {createState.error.message}
                    </AlertDescription>
                </Alert>
            {/if}
            {#if testState.isError}
                <Alert variant="error" class="mb-4" role="alert">
                    <AlertDescription>
                        {testState.error.message}
                    </AlertDescription>
                </Alert>
            {:else if testState.data}
                <Alert
                    variant={testState.data.success
                        ? "success"
                        : "error"}
                    class="mb-4"
                    role="status"
                >
                    <AlertDescription>
                        {testState.data.message}
                    </AlertDescription>
                </Alert>
            {/if}
            <form
                id="create-s3-connection-form"
                method="POST"
                onsubmit={create}
                class="space-y-4"
                aria-busy={pending}
            >
                <Field>
                    <Label for="s3-provider" required>Provider</Label>
                    <Select
                        value={provider}
                        items={providerItems}
                        disabled={pending}
                        onValueChange={selectProvider}
                    >
                        <SelectTrigger id="s3-provider">
                            <ProviderIcon {provider} />
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {#each S3_PROVIDER_IDS as id (id)}
                                <SelectItem
                                    value={id}
                                    label={s3Providers[id].name}
                                >
                                    <ProviderIcon provider={id} />
                                    {s3Providers[id].name}
                                </SelectItem>
                            {/each}
                        </SelectContent>
                    </Select>
                    <FieldDescription>
                        {s3Providers[provider].description}
                    </FieldDescription>
                </Field>
                <Field>
                    <Label for="s3-name" required>Name</Label>
                    <Input
                        id="s3-name"
                        bind:value={name}
                        placeholder="Production storage"
                        autocomplete="off"
                        maxlength={100}
                        disabled={pending}
                    />
                </Field>
                <ConnectionFields
                    {provider}
                    disabled={pending}
                    bind:endpoint={draft.endpoint}
                    bind:region={draft.region}
                    bind:forcePathStyle={draft.forcePathStyle}
                    bind:accountId={draft.accountId}
                    bind:accessKey={draft.accessKey}
                    bind:secretKey={draft.secretKey}
                    bind:apiToken={draft.apiToken}
                />
            </form>
        </DialogPanel>
        <DialogFooter>
            <Button
                variant="outline"
                onclick={test}
                loading={testState.isPending}
                disabled={!complete || pending}
            >
                Test connection
            </Button>
            <Button
                type="submit"
                form="create-s3-connection-form"
                loading={createState.isPending}
                disabled={!complete || !name.trim() || pending}
            >
                Create connection
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
