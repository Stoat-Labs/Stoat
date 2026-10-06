<script lang="ts">
    import { invalidateAll } from "$app/navigation";
    import { authClient } from "$lib/auth-client";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Field } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { onMount } from "svelte";
    import SettingsSection from "./settings-section.svelte";

    let {
        organization,
        canManage,
    }: {
        organization: { id: string; name: string; slug: string };
        canManage: boolean;
    } = $props();

    let name = $state("");

    let slug = $state("");

    let ready = $state(false);

    let pending = $state(false);

    let error = $state("");

    let saved = $state(false);

    onMount(() => {
        name = organization.name;
        slug = organization.slug;
        ready = true;
    });

    const unchanged = $derived(
        name.trim() === organization.name &&
            slug.trim() === organization.slug,
    );

    async function save(event: SubmitEvent) {
        event.preventDefault();

        if (pending) return;
        pending = true;
        error = "";
        saved = false;

        try {
            const result = await authClient.organization.update({
                organizationId: organization.id,
                data: { name: name.trim(), slug: slug.trim() },
            });

            if (result.error) {
                error =
                    result.error.message ??
                    "Unable to update the organization.";

                return;
            }

            await invalidateAll();
            saved = true;
        } catch {
            error = "Unable to save the organization. Try again.";
        } finally {
            pending = false;
        }
    }
</script>

<SettingsSection
    title="General"
    description="The name and slug identify this organization."
>
    <form
        onsubmit={save}
        class="max-w-xl space-y-4"
        aria-busy={pending}
    >
        <Field>
            <Label for="organization-name">Name</Label>
            <Input
                id="organization-name"
                bind:value={name}
                required
                maxlength={100}
                pattern=".*\S.*"
                disabled={!ready || pending || !canManage}
            />
        </Field>
        <Field>
            <Label for="organization-slug">Slug</Label>
            <Input
                id="organization-slug"
                bind:value={slug}
                required
                maxlength={64}
                pattern="[a-z0-9]+(-[a-z0-9]+)*"
                title="Lowercase letters, numbers and dashes"
                disabled={!ready || pending || !canManage}
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
                    Organization updated.
                </AlertDescription>
            </Alert>
        {/if}
        {#if !canManage}
            <p class="text-xs text-muted-foreground">
                Only owners can change these settings.
            </p>
        {:else}
            <Button
                type="submit"
                disabled={!ready || unchanged}
                loading={pending}
            >
                Save changes
            </Button>
        {/if}
    </form>
</SettingsSection>
