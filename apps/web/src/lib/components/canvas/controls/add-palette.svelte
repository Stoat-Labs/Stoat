<script lang="ts" module>
    export const addPages = [
        "root",
        "git",
        "database",
        "template",
        "docker",
    ] as const;

    export type AddPage = (typeof addPages)[number];
</script>

<script lang="ts">
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import { ORPCError } from "@orpc/client";
    import ProviderIcon from "$lib/components/connections/provider-icon.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
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
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import type { AppRouterClient } from "@stoat/api/routers/index";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import Box from "@lucide/svelte/icons/box";
    import ChevronRight from "@lucide/svelte/icons/chevron-right";
    import Container from "@lucide/svelte/icons/container";
    import Database from "@lucide/svelte/icons/database";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import Info from "@lucide/svelte/icons/info";
    import Layers from "@lucide/svelte/icons/layers";
    import Settings from "@lucide/svelte/icons/settings";
    import SquareTerminal from "@lucide/svelte/icons/square-terminal";
    import {
        createQueries,
        createQuery,
    } from "@tanstack/svelte-query";
    import {
        parseAsString,
        parseAsStringLiteral,
        useQueryState,
    } from "nuqs-svelte";
    import type { Component } from "svelte";
    import {
        imageCompose,
        imageServiceName,
        isImageReference,
    } from "./docker-image";
    import TemplateDialog from "./template-dialog.svelte";

    let {
        projectId,
        inline = false,
        oncreated,
    }: {
        projectId: string;
        /** Railway's empty project: the palette sits open on the canvas instead of in a dialog. */
        inline?: boolean;
        /** Runs with the new resource's id once it is on the canvas. */
        oncreated: (resourceId: string) => void;
    } = $props();

    type CreateInput = Omit<
        Parameters<AppRouterClient["resources"]["createResource"]>[0],
        "projectId"
    >;

    type Template = Awaited<
        ReturnType<AppRouterClient["resources"]["listTemplates"]>
    >[number];

    type Entry = {
        id: string;
        label: string;
        description: string | undefined;
        logo: string | null;
        icon: Component;
        /** A Git provider's logo instead of `icon`. */
        provider: string | undefined;
        /** A palette sub-page, a page to open, or a resource to add to the canvas. */
        target:
            | { page: AddPage }
            | { href: string }
            | { create: CreateInput }
            | { template: Template };
    };

    // Which palette page is open; `null` closes it. Kept in the URL like the canvas selection.
    const add = useQueryState(
        "add",
        parseAsStringLiteral(addPages).withOptions({
            shallow: true,
            scroll: false,
        }),
    );

    // The template whose variables are being filled in, by app id.
    const configuring = useQueryState(
        "addTemplate",
        parseAsString.withOptions({ shallow: true, scroll: false }),
    );

    // Inline, the palette is always open, so no page means the first one.
    const current = $derived(add.current ?? (inline ? "root" : null));

    let query = $state("");

    let creating = $state(false);

    let createError = $state("");

    const create = $derived(`/projects/${projectId}/create`);

    const templatesQuery = createQuery(() =>
        orpc.resources.listTemplates.queryOptions({
            enabled:
                current === "template" ||
                current === "database" ||
                configuring.current !== null,
        }),
    );

    const connectionsQuery = createQuery(() =>
        orpc.connections.list.queryOptions({
            enabled: current === "git",
        }),
    );

    const connections = $derived(
        current === "git"
            ? (connectionsQuery.data?.connections ?? [])
            : [],
    );

    // Railway lists every repository it can reach; here that is every connection's.
    const repositoryQueries = createQueries(() => ({
        queries: connections.map((connection) =>
            orpc.connections.getRepositories.queryOptions({
                input: { connectionId: connection.id },
            }),
        ),
    }));

    const configuredTemplate = $derived(
        templatesQuery.data?.find(
            (template) => template.appId === configuring.current,
        ),
    );

    const rootEntries = $derived<Entry[]>([
        {
            id: "git",
            label: "Git Repository",
            description: undefined,
            logo: null,
            icon: GitBranch,
            provider: undefined,
            target: { page: "git" },
        },
        {
            id: "database",
            label: "Database",
            description: undefined,
            logo: null,
            icon: Database,
            provider: undefined,
            target: { page: "database" },
        },
        {
            id: "template",
            label: "Template",
            description: undefined,
            logo: null,
            icon: Layers,
            provider: undefined,
            target: { page: "template" },
        },
        {
            id: "docker",
            label: "Docker Image",
            description: undefined,
            logo: null,
            icon: Container,
            provider: undefined,
            target: { page: "docker" },
        },
        // Buckets need an S3 connection, so they keep their create page, as before.
        ...(page.data.isOrganizationAdmin
            ? [
                  {
                      id: "bucket",
                      label: "Bucket",
                      description: undefined,
                      logo: null,
                      icon: HardDrive,
                      provider: undefined,
                      target: { href: `${create}/bucket` },
                  },
              ]
            : []),
        {
            id: "empty",
            label: "Empty Service",
            description: undefined,
            logo: null,
            icon: SquareTerminal,
            provider: undefined,
            target: { create: { name: "Empty Service" } },
        },
    ]);

    const templateEntries = $derived(
        (templatesQuery.data ?? []).flatMap((template): Entry[] =>
            (template.type === "database") ===
            (current === "database")
                ? [
                      {
                          id: template.appId,
                          label: template.name,
                          description:
                              current === "database"
                                  ? undefined
                                  : template.description,
                          logo: template.logo,
                          icon: Box,
                          provider: undefined,
                          target: { template },
                      },
                  ]
                : [],
        ),
    );

    const gitEntries = $derived<Entry[]>([
        {
            id: "configure",
            label: "Configure Git Connections",
            description: undefined,
            logo: null,
            icon: Settings,
            provider: undefined,
            target: { href: "/git" },
        },
        ...connections.flatMap((connection, index) =>
            (repositoryQueries[index]?.data?.repositories ?? []).map(
                (repository): Entry => ({
                    id: `${connection.id}/${repository.url}`,
                    label: repository.name,
                    description: connection.name,
                    logo: null,
                    icon: GitBranch,
                    provider: connection.provider,
                    // Without a known default branch, the create page asks for one. Quick creation
                    // reads the root; without a Compose file there, it falls back to that page too.
                    target: repository.defaultBranch
                        ? {
                              create: {
                                  name:
                                      repository.name
                                          .split("/")
                                          .at(-1) ?? repository.name,
                                  git: {
                                      connectionId: connection.id,
                                      repositoryUrl: repository.url,
                                      branch: repository.defaultBranch,
                                      path: ".",
                                  },
                              },
                          }
                        : {
                              href: `${create}/git?${new URLSearchParams(
                                  {
                                      connectionId: connection.id,
                                      repositoryUrl: repository.url,
                                  },
                              )}`,
                          },
                }),
            ),
        ),
    ]);

    const image = $derived(query.trim());

    const dockerEntries = $derived<Entry[]>(
        isImageReference(image)
            ? [
                  {
                      id: "image",
                      label: image,
                      description: undefined,
                      logo: null,
                      icon: Container,
                      provider: undefined,
                      target: {
                          create: {
                              name: imageServiceName(image),
                              compose: imageCompose(image),
                          },
                      },
                  },
              ]
            : [],
    );

    const items = $derived(
        current === "git"
            ? gitEntries
            : current === "docker"
              ? dockerEntries
              : current === "template" || current === "database"
                ? templateEntries
                : rootEntries,
    );

    const titles: Record<AddPage, string> = {
        root: "",
        git: "Git Repository",
        database: "Database",
        template: "Template",
        docker: "Docker Image",
    };

    const placeholders: Record<AddPage, string> = {
        root: "What would you like to create?",
        git: "Search repositories...",
        database: "Choose a database...",
        template: "Search templates...",
        docker: "traefik/whoami",
    };

    const placeholder = $derived(placeholders[current ?? "root"]);

    const repositoriesPending = $derived(
        connectionsQuery.isPending ||
            repositoryQueries.some((result) => result.isPending),
    );

    const repositoryErrors = $derived(
        connections.flatMap((connection, index) => {
            const result = repositoryQueries[index];

            return result?.isError
                ? [`${connection.name}: ${result.error.message}`]
                : [];
        }),
    );

    function open(next: AddPage | null) {
        query = "";
        createError = "";
        void add.set(next);
    }

    async function createResource(input: CreateInput) {
        if (creating) return;

        creating = true;
        createError = "";

        try {
            const resource = await client.resources.createResource({
                projectId,
                ...input,
            });

            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.getProjectGraph.key(),
                }),
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.key(),
                }),
                queryClient.invalidateQueries({
                    queryKey: orpc.projects.key(),
                }),
            ]);

            open(null);
            void configuring.set(null);

            if (resource) oncreated(resource.id);
        } catch (cause) {
            // No Compose file at the repository root: let the Git form pick the file or branch.
            if (
                input.git &&
                cause instanceof ORPCError &&
                cause.code === "NOT_FOUND"
            ) {
                open(null);
                void goto(
                    `${create}/git?${new URLSearchParams({
                        connectionId: input.git.connectionId,
                        repositoryUrl: input.git.repositoryUrl,
                        branch: input.git.branch,
                    })}`,
                );

                return;
            }

            createError =
                cause instanceof Error
                    ? cause.message
                    : "Unable to create the resource.";
        } finally {
            creating = false;
        }
    }

    function templateInput(
        template: Template,
        variables: Record<string, string>,
    ): CreateInput {
        return {
            name: template.name,
            template: {
                appId: template.appId,
                version: template.versions[0]?.version ?? "",
                variables,
            },
        };
    }

    function choose(entry: Entry) {
        if (creating) return;

        const { target } = entry;

        if ("page" in target) open(target.page);
        else if ("href" in target) void goto(target.href);
        else if ("create" in target)
            void createResource(target.create);
        else if (target.template.versions[0]?.required.length) {
            // Railway asks for nothing; Stoat templates may need values first.
            open(null);
            void configuring.set(target.template.appId);
        } else
            void createResource(templateInput(target.template, {}));
    }
</script>

{#snippet palette()}
    {#if current && current !== "root"}
        <!-- Railway's breadcrumb chip, with the way back beside it. -->
        <div class="flex items-center gap-1.5 px-2.5 pt-2.5">
            <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Back"
                onclick={() => open("root")}
            >
                <ArrowLeft class="size-4" aria-hidden="true" />
            </Button>
            <span
                class="rounded-md border bg-muted/60 px-2 py-0.5 text-xs font-medium"
            >
                {titles[current]}
            </span>
        </div>
    {/if}
    <Command
        {items}
        bind:value={query}
        itemToStringValue={(entry: Entry) =>
            `${entry.label} ${entry.description ?? ""}`}
    >
        <CommandInput
            {placeholder}
            aria-label={placeholder}
            disabled={creating}
            onkeydown={(event) => {
                // Backspace on an empty search returns to the first page, as in Railway.
                if (
                    event.key === "Backspace" &&
                    query === "" &&
                    current !== "root"
                )
                    open("root");
            }}
        />
        {#if createError}
            <Alert variant="error" class="mx-2.5 mb-1.5 w-auto">
                <AlertDescription>{createError}</AlertDescription>
            </Alert>
        {/if}
        {#if current === "git" && repositoryErrors.length > 0}
            <Alert variant="warning" class="mx-2.5 mb-1.5 w-auto">
                <AlertDescription>
                    {repositoryErrors.join(" ")}
                </AlertDescription>
            </Alert>
        {/if}
        {#if current === "docker"}
            <p
                class="mx-2.5 mb-1.5 flex items-center gap-2 rounded-lg bg-info/8 px-3 py-2 text-sm text-info-foreground dark:bg-info/16"
            >
                <Info class="size-4 shrink-0" aria-hidden="true" />
                Enter an image from any registry the cluster can pull from.
            </p>
        {/if}
        <CommandEmpty>
            {#if current === "docker"}
                <div class="space-y-1.5 px-1 text-start">
                    <p class="font-medium text-foreground">
                        Examples
                    </p>
                    <ul
                        class="list-inside list-disc space-y-0.5 font-mono text-xs"
                    >
                        <li>traefik/whoami</li>
                        <li>ghcr.io/username/repo:latest</li>
                        <li>quay.io/username/repo:tag</li>
                        <li>registry.gitlab.com/username/repo:tag</li>
                    </ul>
                </div>
            {:else if current === "git" && repositoriesPending}
                Loading repositories...
            {:else if (current === "template" || current === "database") && templatesQuery.isPending}
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
                        disabled={creating}
                        class="min-h-11 gap-3 rounded-lg px-3 py-3 text-muted-foreground data-highlighted:text-foreground sm:min-h-11"
                        onclick={() => choose(entry)}
                    >
                        {#if entry.provider}
                            <ProviderIcon provider={entry.provider} />
                        {:else if entry.logo}
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
                        {:else if creating}
                            <span class="text-xs">Adding...</span>
                        {/if}
                    </CommandItem>
                {/snippet}
            </CommandCollection>
        </CommandList>
    </Command>
{/snippet}

{#if inline}
    <!-- The dialog's size and surface, but part of the page. -->
    <div
        class="flex max-h-105 w-[420px] max-w-[calc(100vw-2rem)] flex-col rounded-2xl border bg-popover text-popover-foreground shadow-lg/5"
    >
        {@render palette()}
    </div>
{:else}
    <CommandDialog
        bind:open={
            () => add.current !== null,
            (next) => {
                if (!next && !creating) open(null);
            }
        }
    >
        <!-- Railway's palette: 420px wide, search on top, 44px rows with 16px icons. -->
        <CommandDialogPopup class="max-w-[420px]">
            {@render palette()}
        </CommandDialogPopup>
    </CommandDialog>
{/if}

{#if configuredTemplate}
    <TemplateDialog
        template={configuredTemplate}
        pending={creating}
        error={createError}
        onsubmit={(variables) =>
            void createResource(
                templateInput(configuredTemplate, variables),
            )}
        onclose={() => {
            createError = "";
            void configuring.set(null);
        }}
    />
{/if}
