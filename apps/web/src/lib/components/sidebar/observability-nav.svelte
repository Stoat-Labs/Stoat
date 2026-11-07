<script lang="ts">
    import { page } from "$app/state";
    import {
        Collapsible,
        CollapsibleContent,
        CollapsibleTrigger,
    } from "$lib/components/ui/collapsible";
    import {
        SidebarMenuButton,
        SidebarMenuItem,
        SidebarMenuSub,
        SidebarMenuSubButton,
        SidebarMenuSubItem,
    } from "$lib/components/ui/sidebar";
    import { sidebarMenuButtonVariants } from "$lib/components/ui/sidebar/sidebar-menu-button.svelte";
    import { useSidebar } from "$lib/components/ui/sidebar/context.svelte";
    import {
        observabilityHref,
        observabilityView,
        observabilityViews,
        type ObservabilityView,
    } from "$lib/observability/navigation";
    import ArrowsLeftRight from "phosphor-svelte/lib/ArrowsLeftRightIcon";
    import Cube from "phosphor-svelte/lib/CubeIcon";
    import Globe from "phosphor-svelte/lib/GlobeIcon";
    import Heartbeat from "phosphor-svelte/lib/HeartbeatIcon";
    import Activity from "phosphor-svelte/lib/PulseIcon";
    import ChevronDown from "phosphor-svelte/lib/CaretDownIcon";
    import SquaresFour from "phosphor-svelte/lib/SquaresFourIcon";

    const { onNavigate }: { onNavigate: () => void } = $props();

    const viewIcons: Record<ObservabilityView, typeof Cube> = {
        overview: SquaresFour,
        dns: Globe,
        http: ArrowsLeftRight,
        services: Cube,
        health: Heartbeat,
    };

    const sidebar = useSidebar();

    const current = $derived(observabilityView(page.url.pathname));

    // Disclosure is local UI state; entering another observability route opens it again.
    let open = $derived(Boolean(current));
</script>

<SidebarMenuItem>
    <Collapsible bind:open>
        {#if sidebar.state === "collapsed" && !sidebar.isMobile}
            <SidebarMenuButton
                isActive={Boolean(current)}
                tooltipContent="Observability"
                aria-label="Expand Observability navigation"
                onclick={() => {
                    sidebar.setOpen(true);
                    open = true;
                }}
            >
                <Activity
                    aria-hidden="true"
                    weight={current ? "fill" : undefined}
                />
            </SidebarMenuButton>
        {:else}
            <CollapsibleTrigger
                class={sidebarMenuButtonVariants()}
                data-active={current ? true : undefined}
                title="Observability"
            >
                <Activity
                    aria-hidden="true"
                    weight={current ? "fill" : undefined}
                />
                <span>Observability</span>
                <ChevronDown
                    aria-hidden="true"
                    class={[
                        "ml-auto size-4 transition-transform motion-reduce:transition-none group-data-[collapsible=icon]:hidden",
                        !open && "-rotate-90",
                    ]}
                />
            </CollapsibleTrigger>
        {/if}
        <CollapsibleContent>
            <SidebarMenuSub>
                {#each observabilityViews as view (view.id)}
                    {@const Icon = viewIcons[view.id]}
                    <SidebarMenuSubItem>
                        <SidebarMenuSubButton
                            href={observabilityHref(
                                view.href,
                                page.url,
                            )}
                            isActive={current?.id === view.id}
                            aria-current={current?.id === view.id
                                ? "page"
                                : undefined}
                            onclick={onNavigate}
                        >
                            <Icon
                                weight={current?.id === view.id
                                    ? "fill"
                                    : undefined}
                            />
                            <span>{view.title}</span>
                        </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                {/each}
            </SidebarMenuSub>
        </CollapsibleContent>
    </Collapsible>
</SidebarMenuItem>
