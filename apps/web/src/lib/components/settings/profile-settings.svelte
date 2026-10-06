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

    let { user }: { user: { name: string; email: string } } =
        $props();

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
</script>

<SettingsSection
    title="Profile"
    description="Your name appears in your organizations."
>
    <form
        onsubmit={save}
        class="max-w-xl space-y-4"
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
                <AlertDescription>Profile updated.</AlertDescription>
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
</SettingsSection>
