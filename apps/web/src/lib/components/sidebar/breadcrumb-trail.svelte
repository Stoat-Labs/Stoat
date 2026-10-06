<script lang="ts" module>
    export type Crumb = {
        label: string;
        href?: string;
        mono?: boolean;
        title?: string;
        /** Shows the resource logo (or a fallback icon) before the label. */
        resource?: { icon?: string | null };
    };
</script>

<script lang="ts">
    import { page } from "$app/state";
    import {
        Breadcrumb,
        BreadcrumbEllipsis,
        BreadcrumbItem,
        BreadcrumbLink,
        BreadcrumbList,
        BreadcrumbPage,
        BreadcrumbSeparator,
    } from "$lib/components/ui/breadcrumb";
    import {
        Menu,
        MenuLinkItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import Boxes from "@lucide/svelte/icons/boxes";
    import { watch } from "runed";
    import type { Snippet } from "svelte";

    let {
        trail,
        trailing,
    }: {
        trail: Crumb[];
        /** Rendered after the current page, e.g. an edit action. */
        trailing?: Snippet;
    } = $props();

    const parents = $derived(trail.slice(0, -1));

    const current = $derived(trail.at(-1));

    let open = $state(false);

    // Link items don't close the menu and SPA navigation keeps it mounted.
    watch(
        () => page.url.pathname,
        () => {
            open = false;
        },
    );
</script>

{#snippet label(crumb: Crumb)}
    {#if crumb.resource}
        {#if crumb.resource.icon}
            <img
                src={crumb.resource.icon}
                alt=""
                class="size-4 shrink-0 rounded object-contain"
            />
        {:else}
            <Boxes
                class="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
            />
        {/if}
    {/if}
    <span class="truncate" class:font-mono={crumb.mono}>
        {crumb.label}
    </span>
{/snippet}

<Breadcrumb class="min-w-0">
    <BreadcrumbList class="flex-nowrap">
        {#if parents.length}
            <BreadcrumbItem class="sm:hidden">
                <Menu bind:open>
                    <MenuTrigger
                        class="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent"
                        aria-label="Show full path"
                    >
                        <BreadcrumbEllipsis />
                    </MenuTrigger>
                    <MenuPopup
                        align="start"
                        sideOffset={8}
                        class="min-w-48 max-w-[calc(100vw-2rem)]"
                    >
                        {#each parents as crumb (crumb.href)}
                            <MenuLinkItem href={crumb.href}>
                                {@render label(crumb)}
                            </MenuLinkItem>
                        {/each}
                    </MenuPopup>
                </Menu>
            </BreadcrumbItem>
            <BreadcrumbSeparator class="sm:hidden" />
        {/if}
        {#each parents as crumb (crumb.href)}
            <BreadcrumbItem class="hidden min-w-0 sm:inline-flex">
                <BreadcrumbLink
                    href={crumb.href}
                    class="flex max-w-48 min-w-0 items-center gap-2"
                    title={crumb.title}
                >
                    {@render label(crumb)}
                </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator class="hidden sm:block" />
        {/each}
        {#if current}
            <BreadcrumbItem class="min-w-0">
                <BreadcrumbPage
                    class="flex max-w-[55vw] min-w-0 items-center gap-2 sm:max-w-64"
                    title={current.title}
                >
                    {@render label(current)}
                </BreadcrumbPage>
                {@render trailing?.()}
            </BreadcrumbItem>
        {/if}
    </BreadcrumbList>
</Breadcrumb>
