<script lang="ts">
    import { invalidateAll } from "$app/navigation";
    import { orpc } from "$lib/api/orpc";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Label } from "$lib/components/ui/label";
    import { Switch } from "$lib/components/ui/switch";
    import { createMutation } from "@tanstack/svelte-query";
    import SettingsSection from "./settings-section.svelte";

    let { canvasMode }: { canvasMode: boolean } = $props();

    const updateMutation = createMutation(() =>
        orpc.userSettings.update.mutationOptions({
            onSuccess: () => invalidateAll(),
        }),
    );
</script>

<SettingsSection
    title="Feature flags"
    description="Opt in or out of features. These follow you across devices."
>
    <div class="flex max-w-xl items-center justify-between gap-4">
        <div class="space-y-1">
            <Label for="canvas-mode">Open projects in canvas mode</Label>
            <p
                id="canvas-mode-description"
                class="text-xs text-muted-foreground"
            >
                Project cards open the canvas instead of the project
                overview. Both views stay reachable from the project.
            </p>
        </div>
        <Switch
            id="canvas-mode"
            aria-describedby="canvas-mode-description"
            checked={canvasMode}
            disabled={updateMutation.isPending}
            onCheckedChange={(checked) =>
                updateMutation.mutate({ canvasMode: checked })}
        />
    </div>
    {#if updateMutation.isError}
        <Alert variant="error" class="mt-4">
            <AlertDescription>
                Unable to save the preference. Try again.
            </AlertDescription>
        </Alert>
    {/if}
</SettingsSection>
