<script lang="ts" module>
    export { addPages, type AddPage } from "./add-palette-entries";
</script>

<script lang="ts">
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import { client, orpc, queryClient } from "$lib/api/orpc";
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
        CommandList,
    } from "$lib/components/ui/command";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import Info from "@lucide/svelte/icons/info";
    import KeyRound from "@lucide/svelte/icons/key-round";
    import Search from "@lucide/svelte/icons/search";
    import { ORPCError } from "@orpc/client";
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
    import {
        addPages,
        bucketEntries,
        dockerEntries,
        dockerHubSearchTerm,
        gitEntries,
        pagePlaceholders,
        pageTitles,
        rootEntries,
        templateEntries,
        templateInput,
        volumeEntries,
        volumeTargetKey,
        type AddPage,
        type CreateInput,
        type Entry,
    } from "./add-palette-entries";
    import AddPaletteItem from "./add-palette-item.svelte";
    import {
        configNodeId,
        volumeNodeId,
        type VolumeTarget,
    } from "../graph";

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

    const volumeTarget = $derived(
        volumeTargets.find(
            (target) => volumeTargetKey(target) === volumeKey.current,
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

    const items = $derived.by((): Entry[] => {
        if (step) return [];

        if (current === "git")
            return gitEntries(
                create,
                connections.map((connection, index) => ({
                    connection,
                    repositories:
                        repositoryQueries[index]?.data
                            ?.repositories ?? [],
                })),
            );

        if (current === "docker")
            return dockerEntries(
                image,
                hubRepository ? (hubQuery.data ?? []) : [],
            );

        // Nothing is listed until the connections load, so the highlight starts on the first one
        // instead of sticking to "Configure S3 Connections", which would otherwise be alone at first.
        if (current === "bucket")
            return s3ConnectionsQuery.isSuccess
                ? bucketEntries(s3Connections)
                : [];

        if (current === "volume" || current === "config")
            return volumeTarget ? [] : volumeEntries(volumeTargets);

        if (current === "template" || current === "database")
            return templateEntries(
                templatesQuery.data ?? [],
                current === "database",
            );

        return rootEntries(
            volumeTargets.length > 0,
            page.data.isOrganizationAdmin === true,
        );
    });

    const s3Connections = $derived(s3ConnectionsQuery.data ?? []);

    const configuredConnection = $derived(
        s3Connections.find(
            (connection) =>
                connection.id === configuringBucket.current,
        ),
    );

    const image = $derived(query.trim());

    const hubRepository = $derived(dockerHubSearchTerm(image));

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
            ? current === "config"
                ? "config"
                : "volume"
            : configuredConnection
              ? "bucket"
              : configuredTemplate
                ? "template"
                : null,
    );

    const placeholder = $derived.by(() => {
        if (step === "volume") return "Mount path of the volume";

        if (step === "config")
            return "Mount path of the file, like /etc/app.conf";

        if (step === "bucket") return "Bucket name";

        if (step === "template") return `Value for ${templateKey}`;

        return pagePlaceholders[current ?? "root"];
    });

    // The chips above the palette: the page, then what the step is about.
    const breadcrumbs = $derived(
        current && current !== "root"
            ? [
                  pageTitles[current],
                  ...((step === "volume" || step === "config") &&
                  volumeTarget
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

    // Enter in a step: the volume, config and bucket steps create, the template one moves to the next variable.
    function submitStep() {
        const value = query.trim();

        createError = "";

        if (
            (step === "volume" || step === "config") &&
            volumeTarget
        ) {
            if (value.startsWith("/"))
                void createMount(volumeTarget, value);
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

    async function createMount(target: VolumeTarget, path: string) {
        if (creating) return;

        creating = true;
        createError = "";

        try {
            const input = {
                projectId,
                resourceId: target.resourceId,
                service: target.service,
                target: path,
            };

            if (step === "config") {
                const created =
                    await client.resources.addConfig(input);

                await showCreated(
                    configNodeId(created.id, created.config),
                );
            } else {
                const created =
                    await client.resources.addVolume(input);

                await showCreated(
                    volumeNodeId(created.id, created.volume),
                );
            }
        } catch (cause) {
            createError =
                cause instanceof Error
                    ? cause.message
                    : `Unable to create the ${step}.`;
        } finally {
            creating = false;
        }
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
            void volumeKey.set(volumeTargetKey(target.volumeService));
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
                    // Keys typed while an input method composes a character belong to it.
                    if (event.isComposing) return;

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
                        <AddPaletteItem
                            {entry}
                            {creating}
                            onchoose={choose}
                        />
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
