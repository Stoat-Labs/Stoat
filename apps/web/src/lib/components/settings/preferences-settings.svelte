<script lang="ts">
    import { Card, CardPanel } from "$lib/components/ui/card";
    import { orpc } from "$lib/api/orpc";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Label } from "$lib/components/ui/label";
    import { Separator } from "$lib/components/ui/separator";
    import { Switch } from "$lib/components/ui/switch";
    import ThemeSwitcher from "$lib/components/theme-switcher.svelte";
    import {
        createMutation,
        useQueryClient,
    } from "@tanstack/svelte-query";
    import { createCanvasModeQuery } from "$lib/api/canvas-mode.svelte";
    import SettingsSection from "./settings-section.svelte";

    const queryClient = useQueryClient();

    const canvasModeQuery = createCanvasModeQuery();

    const updateMutation = createMutation(() =>
        orpc.userSettings.update.mutationOptions({
            onSuccess: (settings) =>
                queryClient.setQueryData(
                    orpc.userSettings.get.queryKey(),
                    settings,
                ),
        }),
    );
</script>

<SettingsSection
    title="Preferences"
    description="How Stoat looks and behaves for you."
>
    <Card>
        <CardPanel class="space-y-5 p-5 sm:p-6">
            <div class="flex items-center justify-between gap-4">
                <div class="space-y-1">
                    <p class="text-sm font-medium">Theme</p>
                    <p class="text-xs text-muted-foreground">
                        Saved on this device.
                    </p>
                </div>
                <ThemeSwitcher />
            </div>
            <Separator />
            <div class="flex items-center justify-between gap-4">
                <div class="space-y-1">
                    <Label for="canvas-mode">
                        Open projects in canvas mode
                    </Label>
                    <p
                        id="canvas-mode-description"
                        class="text-xs text-muted-foreground"
                    >
                        Project cards open the canvas instead of the
                        project overview. Both views stay reachable
                        from the project.
                    </p>
                </div>
                <Switch
                    id="canvas-mode"
                    aria-describedby="canvas-mode-description"
                    checked={canvasModeQuery.data.canvasMode}
                    disabled={updateMutation.isPending}
                    onCheckedChange={(checked) =>
                        updateMutation.mutate({
                            canvasMode: checked,
                        })}
                />
            </div>
            {#if updateMutation.isError}
                <Alert variant="error">
                    <AlertDescription>
                        Unable to save the preference. Try again.
                    </AlertDescription>
                </Alert>
            {/if}
        </CardPanel>
    </Card>
</SettingsSection>
