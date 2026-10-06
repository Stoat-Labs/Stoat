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
    } from "$lib/observability-navigation";
    import Activity from "@lucide/svelte/icons/activity";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";

    const { onNavigate }: { onNavigate: () => void } = $props();

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
                <Activity aria-hidden="true" />
            </SidebarMenuButton>
        {:else}
            <CollapsibleTrigger
                class={sidebarMenuButtonVariants()}
                data-active={current ? true : undefined}
                title="Observability"
            >
                <Activity aria-hidden="true" />
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
                            <span>{view.title}</span>
                        </SidebarMenuSubButton>
                    </SidebarMenuSubItem>
                {/each}
            </SidebarMenuSub>
        </CollapsibleContent>
    </Collapsible>
</SidebarMenuItem>
