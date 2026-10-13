<script lang="ts" module>
    export const addPages = ["root", "template", "database"] as const;

    export type AddPage = (typeof addPages)[number];
</script>

<script lang="ts">
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import {
        Command,
        CommandCollection,
        CommandDialog,
        CommandDialogPopup,
        CommandEmpty,
        CommandInput,
        CommandItem,
        CommandList,
    } from "$lib/components/ui/command";
    import { orpc } from "$lib/api/orpc";
    import Box from "@lucide/svelte/icons/box";
    import ChevronRight from "@lucide/svelte/icons/chevron-right";
    import Database from "@lucide/svelte/icons/database";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import Layers from "@lucide/svelte/icons/layers";
    import SquareTerminal from "@lucide/svelte/icons/square-terminal";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsStringLiteral, useQueryState } from "nuqs-svelte";
    import type { Component } from "svelte";

    let { projectId }: { projectId: string } = $props();

    type Entry = {
        id: string;
        label: string;
        description: string | undefined;
        logo: string | null;
        icon: Component;
        /** A sub-page of the palette, or a create page to open. */
        target: { page: AddPage } | { href: string };
    };

    // Which palette page is open; `null` closes it. Kept in the URL like the canvas selection.
    const add = useQueryState(
        "add",
        parseAsStringLiteral(addPages).withOptions({
            shallow: true,
            scroll: false,
        }),
    );

    let query = $state("");

    const templatesQuery = createQuery(() =>
        orpc.resources.listTemplates.queryOptions({
            enabled:
                add.current === "template" ||
                add.current === "database",
        }),
    );

    const create = $derived(`/projects/${projectId}/create`);

    // Railway's Add menu, mapped onto Stoat's existing create pages.
    const rootEntries = $derived<Entry[]>([
        {
            id: "git",
            label: "Git Repository",
            description: undefined,
            logo: null,
            icon: GitBranch,
            target: { href: `${create}/git` },
        },
        {
            id: "database",
            label: "Database",
            description: undefined,
            logo: null,
            icon: Database,
            target: { page: "database" },
        },
        {
            id: "template",
            label: "Template",
            description: undefined,
            logo: null,
            icon: Layers,
            target: { page: "template" },
        },
        // Provisioning buckets is for owners and admins, as on the create page.
        ...(page.data.isOrganizationAdmin
            ? [
                  {
                      id: "bucket",
                      label: "Bucket",
                      description: undefined,
                      logo: null,
                      icon: HardDrive,
                      target: { href: `${create}/bucket` },
                  },
              ]
            : []),
        {
            id: "compose",
            label: "Empty Compose",
            description: undefined,
            logo: null,
            icon: SquareTerminal,
            target: { href: `${create}/compose` },
        },
    ]);

    const templateEntries = $derived(
        (templatesQuery.data ?? []).flatMap((template): Entry[] =>
            (template.type === "database") ===
            (add.current === "database")
                ? [
                      {
                          id: template.appId,
                          label: template.name,
                          description: template.description,
                          logo: template.logo,
                          icon: Box,
                          target: {
                              href: `${create}/${encodeURIComponent(template.appId)}`,
                          },
                      },
                  ]
                : [],
        ),
    );

    const items = $derived(
        add.current === "root" ? rootEntries : templateEntries,
    );

    const placeholders: Record<AddPage, string> = {
        root: "What would you like to create?",
        template: "Search templates...",
        database: "Choose a database...",
    };

    const placeholder = $derived(placeholders[add.current ?? "root"]);

    function choose(entry: Entry) {
        if ("page" in entry.target) {
            query = "";
            void add.set(entry.target.page);

            return;
        }

        void goto(entry.target.href);
    }
</script>

<CommandDialog
    bind:open={
        () => add.current !== null,
        (open) => {
            if (!open) {
                query = "";
                void add.set(null);
            }
        }
    }
>
    <!-- Railway's palette: 420px wide, search on top, 44px rows with 16px icons. -->
    <CommandDialogPopup class="max-w-[420px]">
        <Command
            {items}
            bind:value={query}
            itemToStringValue={(entry: Entry) =>
                `${entry.label} ${entry.description ?? ""}`}
        >
            <CommandInput
                {placeholder}
                aria-label={placeholder}
                onkeydown={(event) => {
                    // Backspace on an empty search returns to the first page, as in Railway.
                    if (
                        event.key === "Backspace" &&
                        query === "" &&
                        add.current !== "root"
                    )
                        void add.set("root");
                }}
            />
            <CommandEmpty>
                {#if templatesQuery.isPending && add.current !== "root"}
                    Loading templates...
                {:else}
                    Nothing matches "{query}".
                {/if}
            </CommandEmpty>
            <CommandList>
                <CommandCollection>
                    {#snippet children(entry: Entry)}
                        <CommandItem
                            value={entry}
                            class="min-h-11 gap-3 rounded-lg px-3 py-3 text-muted-foreground data-highlighted:text-foreground sm:min-h-11"
                            onclick={() => choose(entry)}
                        >
                            {#if entry.logo}
                                <img
                                    src={entry.logo}
                                    alt=""
                                    aria-hidden="true"
                                    class="size-4 shrink-0 object-contain"
                                />
                            {:else}
                                <entry.icon
                                    class="size-4 shrink-0"
                                    aria-hidden="true"
                                />
                            {/if}
                            <span class="min-w-0 flex-1">
                                <span class="block truncate">
                                    {entry.label}
                                </span>
                                {#if entry.description}
                                    <span
                                        class="block truncate text-xs text-muted-foreground"
                                    >
                                        {entry.description}
                                    </span>
                                {/if}
                            </span>
                            {#if "page" in entry.target}
                                <ChevronRight
                                    class="size-4 shrink-0"
                                    aria-hidden="true"
                                />
                            {/if}
                        </CommandItem>
                    {/snippet}
                </CommandCollection>
            </CommandList>
        </Command>
    </CommandDialogPopup>
</CommandDialog>
