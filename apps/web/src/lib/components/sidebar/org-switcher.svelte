<script lang="ts">
    import { page } from "$app/state";
    import { authClient } from "$lib/auth-client";
    import CreateOrganizationDialog from "$lib/components/organization/create-organization-dialog.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import {
        Menu,
        MenuGroup,
        MenuGroupLabel,
        MenuItem,
        MenuPopup,
        MenuSeparator,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import { sidebarMenuButtonVariants } from "$lib/components/ui/sidebar/sidebar-menu-button.svelte";
    import {
        SidebarMenu,
        SidebarMenuItem,
    } from "$lib/components/ui/sidebar";
    import { useSidebar } from "$lib/components/ui/sidebar/context.svelte";
    import Boxes from "@lucide/svelte/icons/boxes";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import Plus from "@lucide/svelte/icons/plus";
    import { parseAsString, useQueryState } from "nuqs-svelte";
    import { watch } from "runed";
    import { onMount } from "svelte";

    let {
        organizations,
        activeOrganizationId,
        onNavigate,
    }: {
        organizations: { id: string; name: string; slug: string }[];
        activeOrganizationId?: string | null;
        onNavigate: () => void;
    } = $props();

    const activeOrganization = $derived(
        organizations.find(
            (organization) =>
                organization.id === activeOrganizationId,
        ),
    );

    const sidebar = useSidebar();

    let open = $state(false);

    let ready = $state(false);

    let pending = $state(false);

    let error = $state("");

    const dialog = useQueryState(
        "dialog",
        parseAsString.withOptions({ shallow: true, scroll: false }),
    );

    onMount(() => {
        ready = true;
    });

    // Link items don't auto-close, and SPA navigation keeps the layout (and
    // its portals) mounted, so close on every route change as a fallback.
    const pathname = $derived(page.url.pathname);

    watch(
        () => pathname,
        (currentPathname) => {
            // Track the route so an open menu never survives navigation.
            if (currentPathname) {
                open = false;
                sidebar.setOpenMobile(false);
            }
        },
    );

    async function switchOrganization(organizationId: string) {
        if (pending || organizationId === activeOrganizationId)
            return;
        pending = true;
        error = "";

        try {
            const result = await authClient.organization.setActive({
                organizationId,
            });

            if (result.error) {
                error =
                    result.error.message ??
                    "Unable to switch organization.";

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

<SidebarMenu>
    <SidebarMenuItem>
        <Menu bind:open>
            <MenuTrigger
                class={sidebarMenuButtonVariants({
                    size: "lg",
                    class: "data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-accent-foreground group-data-[collapsible=icon]:justify-center",
                })}
                disabled={!ready || pending}
                aria-label="Switch organization"
                title={activeOrganization?.name ??
                    "Select organization"}
            >
                <span
                    class="flex size-8 shrink-0 items-center justify-center rounded-lg group-data-[collapsible=icon]:size-6"
                >
                    <Boxes class="size-full" aria-hidden="true" />
                </span>
                <span
                    class="grid min-w-0 flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden"
                >
                    <span class="truncate font-semibold">
                        {activeOrganization?.name ??
                            "Select organization"}
                    </span>
                    <span class="truncate text-xs">
                        {activeOrganization?.slug ?? "Organization"}
                    </span>
                </span>
                <ChevronDown
                    class="ml-auto size-4 shrink-0 group-data-[collapsible=icon]:hidden"
                    aria-hidden="true"
                />
            </MenuTrigger>
            <MenuPopup
                class="w-(--anchor-width) min-w-56 max-w-[calc(100vw-2rem)]"
                align="start"
                side="bottom"
                sideOffset={4}
            >
                <MenuGroup>
                    <MenuGroupLabel>Organizations</MenuGroupLabel>
                    {#each organizations as organization (organization.id)}
                        <MenuItem
                            class="gap-2 p-2"
                            disabled={pending}
                            onclick={() =>
                                switchOrganization(organization.id)}
                        >
                            <span
                                class="flex size-6 shrink-0 items-center justify-center rounded-sm border"
                            >
                                <Boxes
                                    class="size-4"
                                    aria-hidden="true"
                                />
                            </span>
                            <span class="truncate">
                                {organization.name}
                            </span>
                            {#if organization.id === activeOrganizationId}<span
                                    class="ml-auto text-xs text-muted-foreground"
                                >
                                    Active
                                </span>{/if}
                        </MenuItem>
                    {/each}
                </MenuGroup>
                <MenuSeparator />
                <MenuItem
                    disabled={!ready || pending}
                    onclick={() => {
                        onNavigate();
                        void dialog.set("create-organization");
                    }}
                    class="gap-2 p-2"
                >
                    <span
                        class="flex size-6 items-center justify-center rounded-md border bg-background"
                    >
                        <Plus class="size-4" aria-hidden="true" />
                    </span>
                    Add organization
                </MenuItem>
            </MenuPopup>
        </Menu>
    </SidebarMenuItem>
</SidebarMenu>
{#if error}
    <Alert
        variant="error"
        class="mx-2 p-2 text-xs group-data-[collapsible=icon]:hidden"
    >
        <AlertDescription>{error}</AlertDescription>
    </Alert>
{/if}
<CreateOrganizationDialog
    bind:open={
        () =>
            ready &&
            !pending &&
            dialog.current === "create-organization",
        (open) => {
            if (!open && dialog.current === "create-organization")
                void dialog.set(null);
        }
    }
/>
