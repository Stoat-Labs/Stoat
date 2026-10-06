<script lang="ts" module>
    import type { Component } from "svelte";

    export const sections = [
        "profile",
        "security",
        "organization",
        "members",
        "api-keys",
        "danger",
    ] as const;

    export type SettingsSectionId = (typeof sections)[number];

    export type SettingsNavGroup = {
        label: string;
        items: {
            value: SettingsSectionId;
            label: string;
            icon: Component;
            variant?: "ghost" | "destructive-ghost";
        }[];
    };
</script>

<script lang="ts">
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Button } from "$lib/components/ui/button";
    import { Separator } from "$lib/components/ui/separator";
    import { cn } from "$lib/utils";

    let {
        groups,
        active,
        onselect,
    }: {
        groups: SettingsNavGroup[];
        active: SettingsSectionId;
        onselect: (value: SettingsSectionId) => void;
    } = $props();
</script>

<Frame
    class="w-full min-w-0 xl:col-span-1 xl:row-span-2 xl:grid xl:grid-rows-subgrid"
>
    <FrameHeader>
        <FrameTitle class="text-base">
            <h2 id="settings-nav-heading">Sections</h2>
        </FrameTitle>
        <FrameDescription class="mt-1">
            Your account and organization.
        </FrameDescription>
    </FrameHeader>
    <nav aria-labelledby="settings-nav-heading" class="px-2 pb-2">
        {#each groups as group, index (group.label)}
            {#if index > 0}<Separator class="my-2" />{/if}
            <div class="space-y-0.5">
                <p
                    class="truncate px-2 py-1.5 text-xs text-muted-foreground"
                    title={group.label}
                >
                    {group.label}
                </p>
                {#each group.items as item (item.value)}
                    {@const Icon = item.icon}
                    {@const variant = item.variant ?? "ghost"}
                    <Button
                        {variant}
                        class="w-full justify-start px-2 aria-[current=page]:bg-accent aria-[current=page]:font-medium"
                        aria-current={item.value === active
                            ? "page"
                            : undefined}
                        onclick={() => onselect(item.value)}
                    >
                        <Icon
                            class={cn(
                                "shrink-0",
                                variant === "ghost" &&
                                    "text-muted-foreground",
                            )}
                            aria-hidden="true"
                        />
                        <span class="truncate">{item.label}</span>
                    </Button>
                {/each}
            </div>
        {/each}
    </nav>
</Frame>
