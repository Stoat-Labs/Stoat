<script lang="ts" module>
    export const addPages = [
        "root",
        "git",
        "database",
        "template",
        "docker",
        "bucket",
        "volume",
    ] as const;

    export type AddPage = (typeof addPages)[number];
</script>

<script lang="ts">
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import ProviderIcon from "$lib/components/connections/provider-icon.svelte";
    import { s3ProviderIcons } from "$lib/components/s3/provider-icon.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
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
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import Box from "@lucide/svelte/icons/box";
    import ChevronRight from "@lucide/svelte/icons/chevron-right";
    import Container from "@lucide/svelte/icons/container";
    import Database from "@lucide/svelte/icons/database";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import Info from "@lucide/svelte/icons/info";
    import KeyRound from "@lucide/svelte/icons/key-round";
    import Layers from "@lucide/svelte/icons/layers";
    import Search from "@lucide/svelte/icons/search";
    import Settings from "@lucide/svelte/icons/settings";
    import SquareTerminal from "@lucide/svelte/icons/square-terminal";
    import { ORPCError } from "@orpc/client";
    import {
        dockerHubLogoUrl,
        dockerHubRepository,
    } from "@stoat/api/docker-hub";
    import type { AppRouterClient } from "@stoat/api/routers/index";
    import { s3Providers } from "@stoat/s3/providers";
    import {
        createQueries,
        createQuery,
        keepPreviousData,
    } from "@tanstack/svelte-query";
    import {
        parseAsString,
        parseAsStringLiteral,
        useQueryState,
    } from "nuqs-svelte";
    import { Debounced } from "runed";
    import type { Component } from "svelte";
    import {
        imageCompose,
        imageServiceName,
        isImageReference,
    } from "./docker-image";
    import { volumeNodeId, type VolumeTarget } from "../graph";

    let {
        projectId,
        volumeTargets,
        inline = false,
        oncreated,
    }: {
        projectId: string;
        /** Services a new volume can be attached to. */
        volumeTargets: VolumeTarget[];
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
            | { template: Template }
            | { bucket: { connectionId: string } }
            | { volumeService: VolumeTarget };
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

    // The S3 connection a bucket is being named for, by connection id.
    const configuringBucket = useQueryState(
        "addBucket",
        parseAsString.withOptions({ shallow: true, scroll: false }),
    );

    // The service a new volume is being attached to, `<resourceId>:<service>`: Railway then asks for
    // the mount path in the same palette.
    const volumeKey = useQueryState(
        "addVolumeTo",
        parseAsString.withOptions({ shallow: true, scroll: false }),
    );

    const keyOf = (target: VolumeTarget) =>
        `${target.resourceId}:${target.service}`;

    const volumeTarget = $derived(
        volumeTargets.find(
            (target) => keyOf(target) === volumeKey.current,
        ),
    );

    // Inline, the palette is always open, so no page means the first one.
    const current = $derived(add.current ?? (inline ? "root" : null));

    let query = $state("");

    let input = $state<HTMLInputElement | null>(null);

    // Each page mounts a new input. Inside the dialog, the focus trap catches focus when the old one
    // is removed, so `autofocus` never fires and the arrow keys would go nowhere.
    $effect(() => {
        input?.focus();
    });

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

    const s3ConnectionsQuery = createQuery(() =>
        orpc.s3.list.queryOptions({
            enabled:
                current === "bucket" ||
                configuringBucket.current !== null,
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
        ...(volumeTargets.length
            ? [
                  {
                      id: "volume",
                      label: "Volume",
                      description: undefined,
                      logo: null,
                      icon: HardDrive,
                      provider: undefined,
                      target: { page: "volume" },
                  } satisfies Entry,
              ]
            : []),
        ...(page.data.isOrganizationAdmin
            ? [
                  {
                      id: "bucket",
                      label: "Bucket",
                      description: undefined,
                      logo: null,
                      icon: HardDrive,
                      provider: undefined,
                      target: { page: "bucket" },
                  } satisfies Entry,
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

    const s3Connections = $derived(s3ConnectionsQuery.data ?? []);

    const configuredConnection = $derived(
        s3Connections.find(
            (connection) =>
                connection.id === configuringBucket.current,
        ),
    );

    // Nothing is listed until the connections load, so the highlight starts on the first one
    // instead of sticking to "Configure S3 Connections", which would otherwise be alone at first.
    const bucketEntries = $derived<Entry[]>(
        s3ConnectionsQuery.isSuccess
            ? [
                  ...s3Connections.map((connection): Entry => ({
                      id: connection.id,
                      label: connection.name,
                      description:
                          s3Providers[connection.provider].name,
                      logo: s3ProviderIcons[connection.provider],
                      icon: HardDrive,
                      provider: undefined,
                      target: {
                          bucket: { connectionId: connection.id },
                      },
                  })),
                  {
                      id: "configure",
                      label: "Configure S3 Connections",
                      description: undefined,
                      logo: null,
                      icon: Settings,
                      provider: undefined,
                      // Without a connection there is nothing to pick, so go straight to adding one.
                      target: {
                          href:
                              s3Connections.length === 0
                                  ? "/s3?dialog=create-connection"
                                  : "/s3",
                      },
                  },
              ]
            : [],
    );

    const volumeEntries = $derived<Entry[]>(
        volumeTargets.map((target) => ({
            id: keyOf(target),
            label: target.label,
            description: undefined,
            logo: target.icon,
            icon: Box,
            provider: undefined,
            target: { volumeService: target },
        })),
    );

    const image = $derived(query.trim());

    // Docker Hub's `library/postgres` is searched as `postgres`; other registries aren't searched.
    const hubRepository = $derived(
        isImageReference(image) ? dockerHubRepository(image) : null,
    );

    const hubSearch = new Debounced(
        () => hubRepository?.replace(/^library\//u, "") ?? "",
        300,
    );

    const hubQuery = createQuery(() =>
        orpc.resources.searchDockerImages.queryOptions({
            input: { query: hubSearch.current },
            enabled: current === "docker" && hubSearch.current !== "",
            placeholderData: keepPreviousData,
            staleTime: 5 * 60_000,
        }),
    );

    function imageEntry(
        reference: string,
        description: string | undefined,
        logo: string | null,
    ): Entry {
        return {
            id: `image:${reference}`,
            label: reference,
            description,
            logo,
            icon: Container,
            provider: undefined,
            target: {
                create: {
                    name: imageServiceName(reference),
                    compose: imageCompose(reference),
                    logoImage: reference,
                },
            },
        };
    }

    // What was typed comes first, then Docker Hub's other matches.
    const dockerEntries = $derived<Entry[]>(
        isImageReference(image)
            ? [
                  imageEntry(
                      image,
                      undefined,
                      hubRepository
                          ? dockerHubLogoUrl(hubRepository)
                          : null,
                  ),
                  ...(hubRepository
                      ? (hubQuery.data ?? [])
                      : []
                  ).flatMap((result) =>
                      dockerHubRepository(result.image) ===
                      hubRepository
                          ? []
                          : [
                                imageEntry(
                                    result.image,
                                    result.description ?? undefined,
                                    result.logo,
                                ),
                            ],
                  ),
              ]
            : [],
    );

    // Docker Hub logos 404 for repositories without one; those rows show `icon` instead.
    let brokenLogos = $state(new Set<string>());

    // Values typed for the template's required variables. They may be secrets, so they stay out of
    // the URL; the template step asks for one variable at a time.
    let templateValues = $state<Record<string, string>>({});

    let templateStep = $state(0);

    const requiredKeys = $derived(
        configuredTemplate?.versions[0]?.required ?? [],
    );

    const templateKey = $derived(requiredKeys[templateStep] ?? "");

    // Railway never opens a second dialog: the last questions are asked in the palette's own input.
    const step = $derived(
        volumeTarget
            ? "volume"
            : configuredConnection
              ? "bucket"
              : configuredTemplate
                ? "template"
                : null,
    );

    const items = $derived(
        step
            ? []
            : current === "git"
              ? gitEntries
              : current === "docker"
                ? dockerEntries
                : current === "bucket"
                  ? bucketEntries
                  : current === "volume"
                    ? volumeTarget
                        ? []
                        : volumeEntries
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
        bucket: "Bucket",
        volume: "Volume",
    };

    const placeholders: Record<AddPage, string> = {
        root: "What would you like to create?",
        git: "Search repositories...",
        database: "Choose a database...",
        template: "Search templates...",
        docker: "traefik/whoami",
        bucket: "Choose an S3 connection...",
        volume: "Service to attach volume to",
    };

    const placeholder = $derived.by(() => {
        if (step === "volume") return "Mount path of the volume";

        if (step === "bucket") return "Bucket name";

        if (step === "template") return `Value for ${templateKey}`;

        return placeholders[current ?? "root"];
    });

    // The chips above the palette: the page, then what the step is about.
    const breadcrumbs = $derived(
        current && current !== "root"
            ? [
                  titles[current],
                  ...(step === "volume" && volumeTarget
                      ? [volumeTarget.label]
                      : step === "bucket" && configuredConnection
                        ? [configuredConnection.name]
                        : step === "template" && configuredTemplate
                          ? [configuredTemplate.name, templateKey]
                          : []),
              ]
            : [],
    );

    const secretCount = $derived(
        configuredTemplate?.versions[0]?.secrets.length ?? 0,
    );

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
        templateValues = {};
        templateStep = 0;
        void volumeKey.set(null);
        void configuring.set(null);
        void configuringBucket.set(null);
        void add.set(next);
    }

    // Enter in a step: the volume and bucket steps create, the template one moves to the next variable.
    function submitStep() {
        const value = query.trim();

        createError = "";

        if (step === "volume" && volumeTarget) {
            if (value.startsWith("/"))
                void createVolume(volumeTarget, value);
            else createError = "The mount path must start with /.";
        } else if (step === "bucket" && configuredConnection) {
            if (/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(value))
                void createBucket(
                    configuredConnection.id,
                    value,
                    value,
                );
            else
                createError =
                    "Bucket names are 3-63 lowercase letters, digits, or hyphens.";
        } else if (step === "template" && configuredTemplate) {
            if (!value) {
                createError = `${templateKey} is required.`;

                return;
            }

            templateValues[templateKey] = value;

            if (templateStep < requiredKeys.length - 1) {
                templateStep += 1;
                query = templateValues[templateKey] ?? "";
            } else
                void createResource(
                    templateInput(configuredTemplate, {
                        ...templateValues,
                    }),
                );
        }
    }

    // The row the arrow keys are on, so → can open its page.
    let highlighted = $state<Entry | undefined>();

    // Escape always steps back; Backspace and ← do once the input is empty, as in Railway.
    function goesBack(event: KeyboardEvent) {
        return (
            event.key === "Escape" ||
            (query === "" &&
                (event.key === "Backspace" ||
                    event.key === "ArrowLeft"))
        );
    }

    // Escape, or Backspace or ← on an empty input, undoes one step.
    function stepBack() {
        createError = "";

        if (step === "template" && templateStep > 0) {
            templateStep -= 1;
            query = templateValues[templateKey] ?? "";

            return;
        }

        query = "";
        templateValues = {};
        templateStep = 0;
        void volumeKey.set(null);
        void configuringBucket.set(null);
        void configuring.set(null);
    }

    async function showCreated(resourceId: string) {
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
        oncreated(resourceId);
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

            if (resource) await showCreated(resource.id);
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

    async function createBucket(
        connectionId: string,
        name: string,
        bucket: string,
    ) {
        if (creating) return;

        creating = true;
        createError = "";

        try {
            const resource = await client.buckets.create({
                projectId,
                connectionId,
                name,
                bucket,
            });

            await showCreated(resource.id);
        } catch (cause) {
            createError =
                cause instanceof Error
                    ? cause.message
                    : "Unable to create the bucket.";
        } finally {
            creating = false;
        }
    }

    async function createVolume(target: VolumeTarget, path: string) {
        if (creating) return;

        creating = true;
        createError = "";

        try {
            const created = await client.resources.addVolume({
                projectId,
                resourceId: target.resourceId,
                service: target.service,
                target: path,
            });

            await showCreated(
                volumeNodeId(created.id, created.volume),
            );
        } catch (cause) {
            createError =
                cause instanceof Error
                    ? cause.message
                    : "Unable to create the volume.";
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
        else if ("volumeService" in target) {
            query = "";
            void volumeKey.set(keyOf(target.volumeService));
        } else if ("bucket" in target) {
            query = "";
            void configuringBucket.set(target.bucket.connectionId);
        } else if (target.template.versions[0]?.required.length) {
            // Railway asks for nothing; Stoat templates may need values first.
            query = "";
            void configuring.set(target.template.appId);
        } else
            void createResource(templateInput(target.template, {}));
    }
</script>

{#snippet palette()}
    {#if breadcrumbs.length}
        <!-- Railway's breadcrumb chips float above the palette. -->
        <div class="absolute start-0 bottom-full mb-2 flex gap-1.5">
            {#each breadcrumbs as crumb, index (index)}
                <span
                    class="rounded-md border bg-popover px-2 py-0.5 font-medium text-popover-foreground text-xs shadow-xs/5"
                >
                    {crumb}
                </span>
            {/each}
        </div>
    {/if}
    <!-- Docker Hub already matched the query, descriptions too, so it isn't filtered again. Steps
         remount it too, so coming back to a list highlights its first row again. -->
    {#key `${current}:${step}`}
        <Command
            {items}
            bind:value={query}
            {...current === "docker" ? { filter: null } : {}}
            itemToStringValue={(entry: Entry) =>
                `${entry.label} ${entry.description ?? ""}`}
            onItemHighlighted={(entry: Entry | undefined) =>
                (highlighted = entry)}
        >
            <CommandInput
                bind:ref={input}
                {placeholder}
                aria-label={placeholder}
                disabled={creating}
                onkeydown={(event) => {
                    if (step) {
                        // A step's input is a value, not a search: Enter submits it.
                        if (event.key === "Enter") {
                            event.preventDefault();
                            submitStep();
                        } else if (goesBack(event)) {
                            event.preventDefault();
                            event.stopPropagation();
                            stepBack();
                        }

                        return;
                    }

                    // → with the caret at the end opens the highlighted row's page, like Enter.
                    if (
                        event.key === "ArrowRight" &&
                        highlighted &&
                        "page" in highlighted.target &&
                        event.currentTarget.selectionStart ===
                            query.length
                    ) {
                        event.preventDefault();
                        choose(highlighted);

                        return;
                    }

                    // Escape steps back a page before it closes the palette.
                    if (current !== "root" && goesBack(event)) {
                        event.preventDefault();
                        event.stopPropagation();
                        open("root");
                    }
                }}
            >
                {#snippet start()}
                    {#if current && current !== "root"}
                        <button
                            type="button"
                            aria-label="Back"
                            class="-ms-0.5 flex rounded-sm p-0.5 hover:bg-accent"
                            onclick={() => {
                                if (step) stepBack();
                                else open("root");

                                input?.focus();
                            }}
                        >
                            <ArrowLeft
                                class="size-4"
                                aria-hidden="true"
                            />
                        </button>
                    {:else}
                        <Search aria-hidden="true" />
                    {/if}
                {/snippet}
            </CommandInput>
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
            {#if step === "bucket" && configuredConnection && !s3Providers[configuredConnection.provider].scopedKeys}
                <p
                    class="mx-2.5 mb-1.5 flex items-center gap-2 rounded-lg bg-info/8 px-3 py-2 text-sm text-info-foreground dark:bg-info/16"
                >
                    <Info
                        class="size-4 shrink-0"
                        aria-hidden="true"
                    />
                    {s3Providers[configuredConnection.provider].name} can't
                    scope keys, so this bucket shares the connection's access
                    keys.
                </p>
            {/if}
            {#if step === "template" && templateStep === requiredKeys.length - 1 && secretCount > 0}
                <p
                    class="mx-2.5 mb-1.5 flex items-center gap-2 rounded-lg bg-info/8 px-3 py-2 text-sm text-info-foreground dark:bg-info/16"
                >
                    <KeyRound
                        class="size-4 shrink-0"
                        aria-hidden="true"
                    />
                    {secretCount}
                    {secretCount === 1 ? "secret is" : "secrets are"} generated
                    for you.
                </p>
            {/if}
            {#if current === "docker"}
                <p
                    class="mx-2.5 mb-1.5 flex items-center gap-2 rounded-lg bg-info/8 px-3 py-2 text-sm text-info-foreground dark:bg-info/16"
                >
                    <Info
                        class="size-4 shrink-0"
                        aria-hidden="true"
                    />
                    Search Docker Hub, or enter an image from any registry
                    the cluster can pull.
                </p>
            {/if}
            {#if step && creating}
                <p class="px-4 pb-3 text-muted-foreground text-xs">
                    Adding...
                </p>
            {/if}
            <!-- A step has no list to be empty. -->
            {#if !step}
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
                                <li>
                                    registry.gitlab.com/username/repo:tag
                                </li>
                            </ul>
                        </div>
                    {:else if current === "bucket" && s3ConnectionsQuery.isPending}
                        Loading connections...
                    {:else if current === "git" && repositoriesPending}
                        Loading repositories...
                    {:else if (current === "template" || current === "database") && templatesQuery.isPending}
                        Loading templates...
                    {:else}
                        Nothing matches "{query}".
                    {/if}
                </CommandEmpty>
            {/if}
            <!-- Browsers fire a mousemove when rows appear under a resting pointer, which would
                 highlight (and scroll to) whatever row landed there instead of the first. -->
            <CommandList
                onmousemovecapture={(event) => {
                    if (
                        event.movementX === 0 &&
                        event.movementY === 0
                    )
                        event.stopPropagation();
                }}
            >
                <CommandCollection>
                    {#snippet children(entry: Entry)}
                        <CommandItem
                            value={entry}
                            disabled={creating}
                            class="min-h-11 gap-3 rounded-lg px-3 py-3 text-muted-foreground data-highlighted:text-foreground sm:min-h-11"
                            onclick={() => choose(entry)}
                        >
                            {#if entry.provider}
                                <ProviderIcon
                                    provider={entry.provider}
                                />
                            {:else if entry.logo && !brokenLogos.has(entry.logo)}
                                {@const logo = entry.logo}
                                <img
                                    src={logo}
                                    alt=""
                                    aria-hidden="true"
                                    class="size-4 shrink-0 object-contain"
                                    onerror={() =>
                                        (brokenLogos = new Set(
                                            brokenLogos,
                                        ).add(logo))}
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
    {/key}
{/snippet}

{#if inline}
    <!-- The dialog's size and surface, but part of the page. -->
    <div
        class="relative flex max-h-105 w-[420px] max-w-[calc(100vw-2rem)] flex-col rounded-2xl border bg-popover text-popover-foreground shadow-lg/5"
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
