<script lang="ts">
    import {
        SidebarMenuButton,
        SidebarMenuItem,
    } from "$lib/components/ui/sidebar";
    import type { Component, Snippet } from "svelte";

    let {
        href,
        title,
        icon,
        active,
        current = active,
        tooltip,
        onclick,
        children,
    }: {
        href: string;
        title?: string;
        icon?: Component;
        active: boolean;
        current?: boolean;
        tooltip?: string;
        onclick?: (event: MouseEvent) => void;
        children: Snippet;
    } = $props();
</script>

<SidebarMenuItem>
    <SidebarMenuButton isActive={active} tooltipContent={tooltip}>
        {#snippet child({ props })}
            <a
                {...props}
                {href}
                {title}
                {onclick}
                aria-current={current ? "page" : undefined}
            >
                {#if icon}
                    {@const Icon = icon}
                    <Icon aria-hidden="true" />
                {/if}
                <span>{@render children()}</span>
            </a>
        {/snippet}
    </SidebarMenuButton>
</SidebarMenuItem>
