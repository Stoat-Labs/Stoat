<script lang="ts">
    import { authClient } from "$lib/auth-client";
    import { Button } from "$lib/components/ui/button";
    import ConfirmDialog from "./confirm-dialog.svelte";
    import SettingsSection from "./settings-section.svelte";

    let {
        organization,
    }: { organization: { id: string; name: string } } = $props();

    let open = $state(false);

    let pending = $state(false);

    let error = $state("");

    async function remove() {
        if (pending) return;
        pending = true;
        error = "";

        try {
            const result = await authClient.organization.delete({
                organizationId: organization.id,
            });

            if (result.error) {
                error =
                    result.error.message ??
                    "Unable to delete the organization.";

                return;
            }

            window.location.assign("/");
        } catch {
            error = "Unable to connect. Try again.";
        } finally {
            pending = false;
        }
    }
</script>

<SettingsSection
    title="Danger zone"
    description="Irreversible actions for {organization.name}."
>
    <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="min-w-0 space-y-1">
            <h3 class="text-sm font-medium">Delete organization</h3>
            <p class="text-sm text-muted-foreground">
                Permanently delete this organization with its projects
                and clusters.
            </p>
        </div>
        <Button
            variant="destructive"
            onclick={() => {
                error = "";
                open = true;
            }}
        >
            Delete organization
        </Button>
    </div>
</SettingsSection>

<ConfirmDialog
    bind:open
    title="Delete organization?"
    description="{organization.name} and its projects and clusters will be permanently deleted. This action cannot be undone."
    confirmLabel="Delete"
    {pending}
    {error}
    onconfirm={remove}
/>
