<!-- Ctrl/Cmd+K from anywhere in the app: jump to any project or resource of the organization. -->
<script lang="ts">
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import { orpc } from "$lib/api/orpc";
    import {
        Command,
        CommandCollection,
        CommandDialog,
        CommandDialogPopup,
        CommandEmpty,
        CommandGroup,
        CommandGroupLabel,
        CommandInput,
        CommandItem,
        CommandList,
    } from "$lib/components/ui/command";
    import Box from "phosphor-svelte/lib/CubeIcon";
    import Database from "phosphor-svelte/lib/DatabaseIcon";
    import FolderOpen from "phosphor-svelte/lib/FolderOpenIcon";
    import HardDrive from "$lib/components/shared/hard-drive-icon.svelte";
    import Plus from "phosphor-svelte/lib/PlusIcon";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsBoolean, useQueryState } from "nuqs-svelte";
    import {
        searchGroups,
        type SearchEntry,
        type SearchGroup,
    } from "./search-entries";

    const open = useQueryState(
        "palette",
        parseAsBoolean
            .withDefault(false)
            .withOptions({ scroll: false }),
    );

    const projectsQuery = createQuery(() =>
        orpc.projects.listProjectOverviews.queryOptions({
            enabled: open.current,
        }),
    );

    const groups = $derived(
        searchGroups(projectsQuery.data ?? [], page.params.projectId),
    );

    let query = $state("");

    function choose(entry: SearchEntry) {
        query = "";
        // Navigating drops ?palette, which closes the dialog.
        void goto(entry.href);
    }
</script>

<svelte:window
    onkeydown={(event) => {
        if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "k"
        ) {
            event.preventDefault();
            void open.set(open.current ? null : true);
        }
    }}
/>

<CommandDialog
    bind:open={
        () => open.current, (value) => void open.set(value || null)
    }
>
    <CommandDialogPopup>
        <Command
            items={groups}
            bind:value={query}
            itemToStringValue={(entry: SearchEntry) =>
                `${entry.label} ${entry.hint}`}
        >
            <CommandInput
                placeholder="Search projects and resources"
                aria-label="Search projects and resources"
            />
            <CommandEmpty>
                {#if projectsQuery.isPending}
                    Loading projects...
                {:else if projectsQuery.isError}
                    Unable to load projects: {projectsQuery.error
                        .message}
                {:else if query}
                    Nothing matches "{query}".
                {:else}
                    No projects yet.
                {/if}
            </CommandEmpty>
            <CommandList>
                <CommandCollection>
                    {#snippet children(group: SearchGroup)}
                        <CommandGroup items={group.items}>
                            <CommandGroupLabel>
                                {group.label}
                            </CommandGroupLabel>
                            <CommandCollection>
                                {#snippet children(
                                    entry: SearchEntry,
                                )}
                                    <CommandItem
                                        value={entry}
                                        class="gap-2"
                                        onclick={() => choose(entry)}
                                    >
                                        {#if entry.icon}
                                            <img
                                                src={entry.icon}
                                                alt=""
                                                class="size-4 shrink-0 object-contain"
                                            />
                                        {:else if entry.kind === "add"}
                                            <Plus
                                                class="size-4 shrink-0 text-muted-foreground"
                                                aria-hidden="true"
                                            />
                                        {:else if entry.kind === "project"}
                                            <FolderOpen
                                                class="size-4 shrink-0 text-muted-foreground"
                                                aria-hidden="true"
                                            />
                                        {:else if entry.type === "bucket"}
                                            <HardDrive
                                                class="size-4 shrink-0 text-muted-foreground"
                                                aria-hidden="true"
                                            />
                                        {:else if entry.type === "database"}
                                            <Database
                                                class="size-4 shrink-0 text-muted-foreground"
                                                aria-hidden="true"
                                            />
                                        {:else}
                                            <Box
                                                class="size-4 shrink-0 text-muted-foreground"
                                                aria-hidden="true"
                                            />
                                        {/if}
                                        <span
                                            class="min-w-0 flex-1 truncate"
                                        >
                                            {entry.label}
                                        </span>
                                        {#if entry.hint}
                                            <span
                                                class="shrink-0 truncate text-xs text-muted-foreground"
                                            >
                                                {entry.hint}
                                            </span>
                                        {/if}
                                    </CommandItem>
                                {/snippet}
                            </CommandCollection>
                        </CommandGroup>
                    {/snippet}
                </CommandCollection>
            </CommandList>
        </Command>
    </CommandDialogPopup>
</CommandDialog>
