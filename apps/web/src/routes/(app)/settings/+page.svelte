<script lang="ts">
    import { invalidateAll } from "$app/navigation";
    import { authClient } from "$lib/auth-client";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "$lib/components/ui/card";
    import { Field } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { onMount } from "svelte";

    let { data } = $props();

    let name = $state("");

    let ready = $state(false);

    let pending = $state(false);

    let error = $state("");

    let saved = $state(false);

    onMount(() => { name = data.user.name; ready = true; });

    const activeOrganization = $derived(data.organizations.find((organization) => organization.id === data.activeOrganizationId));

    const canManageKeys = $derived(activeOrganization?.role.split(",").some((role) => role.trim() === "owner") ?? false);

    type ApiKeyRow = { id: string; name: string | null; start: string | null; createdAt: Date };

    let keys = $state<ApiKeyRow[]>([]);

    let keyName = $state("");

    let createdKey = $state("");

    let keyPending = $state(false);

    let keyError = $state("");

    async function loadKeys() {
        if (!canManageKeys || !activeOrganization) return;

        const result = await authClient.apiKey.list({ query: { organizationId: activeOrganization.id } });

        if (result.error) keyError = result.error.message ?? "Unable to load API keys.";
        else keys = result.data.apiKeys;
    }

    $effect(() => { void loadKeys(); });

    async function createKey(event: SubmitEvent) {
        event.preventDefault();

        if (keyPending || !activeOrganization) return;
        keyPending = true;
        keyError = "";
        createdKey = "";

        try {
            const result = await authClient.apiKey.create({ name: keyName.trim(), organizationId: activeOrganization.id });

            if (result.error) { keyError = result.error.message ?? "Unable to create the API key.";

 return; }

            createdKey = result.data.key;
            keyName = "";
            await loadKeys();
        } finally { keyPending = false; }
    }

    async function deleteKey(keyId: string) {
        if (!confirm("Delete this API key? Anything using it will stop working.")) return;
        keyError = "";

        const result = await authClient.apiKey.delete({ keyId });

        if (result.error) keyError = result.error.message ?? "Unable to delete the API key.";
        else await loadKeys();
    }

    async function save(event: SubmitEvent) {
        event.preventDefault();

        if (pending) return;
        pending = true;
        error = "";
        saved = false;

        try {
            const result = await authClient.updateUser({ name: name.trim() });

            if (result.error) { error = result.error.message ?? "Unable to update your profile.";

 return; }

            await invalidateAll();
            saved = true;
        } catch { error = "Unable to save your profile. Try again."; }
        finally { pending = false; }
    }
</script>

<svelte:head><title>Settings / Stoat</title></svelte:head>
<div class="mx-auto max-w-2xl space-y-6 py-6">
    <Card>
        <CardHeader>
            <CardTitle class="text-base">Profile</CardTitle>
            <CardDescription>Your name appears in your organizations.</CardDescription>
        </CardHeader>
        <CardPanel>
            <form method="POST" onsubmit={save} class="space-y-4" aria-busy={pending}>
                <Field><Label for="profile-name">Full name</Label><Input id="profile-name" autocomplete="name" bind:value={name} required maxlength={100} pattern=".*\S.*" disabled={!ready || pending} /></Field>
                <Field><Label for="profile-email">Email</Label><Input id="profile-email" type="email" value={data.user.email} readonly /></Field>
                {#if error}
                    <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert>
                {/if}
                {#if saved}
                    <Alert variant="success" role="status"><AlertDescription>Profile updated.</AlertDescription></Alert>
                {/if}
                <Button type="submit" disabled={!ready || name.trim() === data.user.name} loading={pending}>Save changes</Button>
            </form>
        </CardPanel>
    </Card>
    {#if canManageKeys && activeOrganization}
        <Card>
            <CardHeader>
                <CardTitle class="text-base">API keys</CardTitle>
                <CardDescription>Keys for {activeOrganization.name}. Send one as the <code>x-api-key</code> header; it has admin access to this organization.</CardDescription>
            </CardHeader>
            <CardPanel class="space-y-4">
                <form onsubmit={createKey} class="flex items-end gap-2" aria-busy={keyPending}>
                    <Field class="flex-1"><Label for="api-key-name">Name</Label><Input id="api-key-name" bind:value={keyName} required maxlength={32} pattern=".*\S.*" placeholder="CI deploys" disabled={keyPending} /></Field>
                    <Button type="submit" loading={keyPending}>Create key</Button>
                </form>
                {#if createdKey}
                    <Alert variant="success" role="status"><AlertDescription>Copy this key now; it won't be shown again.<code class="mt-2 block break-all select-all">{createdKey}</code></AlertDescription></Alert>
                {/if}
                {#if keyError}
                    <Alert variant="error"><AlertDescription>{keyError}</AlertDescription></Alert>
                {/if}
                {#if keys.length}
                    <ul class="divide-y rounded-md border">
                        {#each keys as key (key.id)}
                            <li class="flex items-center justify-between gap-4 px-3 py-2 text-sm">
                                <div><div class="font-medium">{key.name ?? "Unnamed key"}</div><div class="text-muted-foreground">{key.start}… · created {new Date(key.createdAt).toLocaleDateString()}</div></div>
                                <Button variant="destructive" size="sm" onclick={() => deleteKey(key.id)}>Delete</Button>
                            </li>
                        {/each}
                    </ul>
                {:else}
                    <p class="text-sm text-muted-foreground">No API keys yet.</p>
                {/if}
            </CardPanel>
        </Card>
    {/if}
</div>
