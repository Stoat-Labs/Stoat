<script lang="ts">
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

    let currentPassword = $state("");

    let newPassword = $state("");

    let confirmPassword = $state("");

    let ready = $state(false);

    let pending = $state(false);

    let error = $state("");

    let saved = $state(false);

    onMount(() => {
        ready = true;
    });

    const mismatch = $derived(
        confirmPassword !== "" && newPassword !== confirmPassword,
    );

    async function save(event: SubmitEvent) {
        event.preventDefault();

        if (pending || mismatch) return;
        pending = true;
        error = "";
        saved = false;

        try {
            const result = await authClient.changePassword({
                currentPassword,
                newPassword,
                revokeOtherSessions: true,
            });

            if (result.error) {
                error =
                    result.error.message ??
                    "Unable to change your password.";

                return;
            }

            currentPassword = newPassword = confirmPassword = "";
            saved = true;
        } catch {
            error = "Unable to change your password. Try again.";
        } finally {
            pending = false;
        }
    }
</script>

<SettingsSection
    title="Password"
    description="Changing it signs you out of your other sessions."
>
    <form
        onsubmit={save}
        class="max-w-xl space-y-4"
        aria-busy={pending}
    >
        <Field>
            <Label for="current-password">Current password</Label>
            <Input
                id="current-password"
                type="password"
                autocomplete="current-password"
                bind:value={currentPassword}
                required
                disabled={!ready || pending}
            />
        </Field>
        <Field>
            <Label for="new-password">New password</Label>
            <Input
                id="new-password"
                type="password"
                autocomplete="new-password"
                bind:value={newPassword}
                required
                minlength={8}
                maxlength={128}
                disabled={!ready || pending}
            />
        </Field>
        <Field>
            <Label for="confirm-password">Confirm new password</Label>
            <Input
                id="confirm-password"
                type="password"
                autocomplete="new-password"
                bind:value={confirmPassword}
                required
                disabled={!ready || pending}
            />
        </Field>
        {#if mismatch}
            <Alert variant="error">
                <AlertDescription>
                    Passwords do not match.
                </AlertDescription>
            </Alert>
        {/if}
        {#if error}
            <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
            </Alert>
        {/if}
        {#if saved}
            <Alert variant="success" role="status">
                <AlertDescription>Password changed.</AlertDescription>
            </Alert>
        {/if}
        <Button
            type="submit"
            disabled={!ready || mismatch}
            loading={pending}
        >
            Change password
        </Button>
    </form>
</SettingsSection>
