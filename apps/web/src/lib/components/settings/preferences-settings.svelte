<script lang="ts">
    import { Card, CardPanel } from "$lib/components/ui/card";
    import { Separator } from "$lib/components/ui/separator";
    import AccentSwitcher from "$lib/components/accent-switcher.svelte";
    import ThemeSwitcher from "$lib/components/theme-switcher.svelte";
    import SettingsSection from "./settings-section.svelte";
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
            <div
                class="flex flex-wrap items-center justify-between gap-4"
            >
                <div class="space-y-1">
                    <p class="text-sm font-medium">Accent color</p>
                    <p class="text-xs text-muted-foreground">
                        Saved on this device.
                    </p>
                </div>
                <AccentSwitcher />
            </div>
        </CardPanel>
    </Card>
</SettingsSection>
