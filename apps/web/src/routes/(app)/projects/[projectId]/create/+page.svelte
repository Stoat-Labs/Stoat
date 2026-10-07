<script lang="ts">
    import { page } from "$app/state";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Empty,
        EmptyDescription,
        EmptyHeader,
    } from "$lib/components/ui/empty";
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import {
        InputGroup,
        InputGroupAddon,
        InputGroupInput,
    } from "$lib/components/ui/input-group";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { orpc } from "$lib/orpc";
    import Box from "@lucide/svelte/icons/box";
    import ChevronRight from "@lucide/svelte/icons/chevron-right";
    import Container from "@lucide/svelte/icons/container";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import Search from "@lucide/svelte/icons/search";
    import type { AppRouterClient } from "@stoat/api/routers/index";
    import { createQuery } from "@tanstack/svelte-query";
    import type { Component } from "svelte";
    import { parseAsString, useQueryStates } from "nuqs-svelte";

    type Entry = {
        href: string;
        name: string;
        meta: string;
        description: string;
        logo: string | null;
        icon: Component;
        tags: string[];
    };

    type Template = Awaited<
        ReturnType<AppRouterClient["resources"]["listTemplates"]>
    >[number];

    const projectId = $derived(page.params.projectId ?? "");

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
            enabled: projectId.length > 0,
        }),
    );

    const project = $derived(projectQuery.data);

    const templatesQuery = createQuery(() =>
        orpc.resources.listTemplates.queryOptions(),
    );

    const filters = useQueryStates(
        {
            q: parseAsString.withDefault(""),
            tag: parseAsString.withDefault("all"),
        },
        { history: "replace", shallow: true, scroll: false },
    );

    const query = $derived(filters.q.current.trim().toLowerCase());

    function matches(entry: Entry) {
        return (
            !query ||
            [entry.name, entry.description, ...entry.tags].some(
                (text) => text.toLowerCase().includes(query),
            )
        );
    }

    const scratch = $derived<Entry[]>([
        {
            href: `/projects/${projectId}/create/compose`,
            name: "Compose",
            meta: "Docker Compose",
            description:
                "Start with an empty Docker Compose spec and write it yourself.",
            logo: null,
            icon: Container,
            tags: [],
        },
        {
            href: `/projects/${projectId}/create/git`,
            name: "Compose from Git",
            meta: "Repository",
            description:
                "Deploy a Docker Compose file from a connected Git repository.",
            logo: null,
            icon: GitBranch,
            tags: [],
        },
        {
            href: `/projects/${projectId}/create/bucket`,
            name: "S3 bucket",
            meta: "Storage",
            description:
                "Provision a bucket and its access keys from an S3 connection.",
            logo: null,
            icon: HardDrive,
            tags: [],
        },
    ]);

    function templateEntry(template: Template): Entry {
        const latest = template.versions[0];
        const services = latest?.services.length ?? 0;

        return {
            href: `/projects/${projectId}/create/${encodeURIComponent(template.appId)}`,
            name: template.name,
            meta: `${services} ${services === 1 ? "service" : "services"}${latest ? ` · ${latest.version}` : ""}`,
            description: template.description,
            logo: template.logo,
            icon: Box,
            tags: template.tags,
        };
    }

    const databases = $derived(
        (templatesQuery.data ?? []).flatMap((template) =>
            template.type === "database"
                ? [templateEntry(template)]
                : [],
        ),
    );

    const otherTemplates = $derived(
        (templatesQuery.data ?? []).flatMap((template) =>
            template.type === "database"
                ? []
                : [templateEntry(template)],
        ),
    );

    const tags = $derived(
        [
            ...new Set(otherTemplates.flatMap((entry) => entry.tags)),
        ].toSorted(),
    );

    const visibleTemplates = $derived(
        otherTemplates.filter(
            (entry) =>
                (filters.tag.current === "all" ||
                    entry.tags.includes(filters.tag.current)) &&
                matches(entry),
        ),
    );

    function clearFilters() {
        void filters.set(null);
    }
</script>

<svelte:head>
    <title>New resource / {project?.name ?? "Project"} / Stoat</title>
</svelte:head>

{#snippet tile(entry: Entry)}
    <li class="flex min-w-0 border-e border-b border-border">
        <a
            href={entry.href}
            class="group flex w-full min-w-0 flex-col gap-3 p-4 outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
            <span class="flex w-full min-w-0 items-center gap-3">
                {#if entry.logo}
                    <img
                        src={entry.logo}
                        alt=""
                        class="size-10 shrink-0 object-contain p-1"
                    />
                {:else}
                    <span
                        class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                    >
                        <entry.icon
                            class="size-5"
                            aria-hidden="true"
                        />
                    </span>
                {/if}
                <span class="min-w-0 flex-1">
                    <span
                        class="block truncate text-sm font-medium leading-5"
                    >
                        {entry.name}
                    </span>
                    <span
                        class="mt-1 block truncate text-xs leading-5 tabular-nums text-muted-foreground"
                    >
                        {entry.meta}
                    </span>
                </span>
                <ChevronRight
                    class="size-4 shrink-0 text-muted-foreground opacity-0 transition-[opacity,translate] group-hover:translate-x-0.5 group-hover:opacity-100 group-focus-visible:opacity-100 motion-reduce:transition-none"
                    aria-hidden="true"
                />
            </span>
            <span
                class="line-clamp-2 flex-1 text-xs leading-5 text-muted-foreground"
            >
                {entry.description}
            </span>
            {#if entry.tags.length > 0}
                <span class="flex flex-wrap gap-1">
                    {#each entry.tags as value (value)}<Badge
                            variant="outline"
                            class="capitalize"
                        >
                            {value}
                        </Badge>{/each}
                </span>
            {/if}
        </a>
    </li>
{/snippet}

{#snippet grid(entries: Entry[])}
    <ul
        class="-me-px -mb-px grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
    >
        {#each entries as entry (entry.href)}
            {@render tile(entry)}
        {/each}
    </ul>
{/snippet}

{#snippet loadingGrid(label: string)}
    <Skeleton loading loading-label={label}>
        <ul
            class="-me-px -mb-px grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3"
        >
            {#each { length: 3 }, index (index)}
                <li
                    class="flex flex-col gap-3 border-e border-b border-border p-4"
                >
                    <span class="flex items-center gap-3">
                        <span
                            class="size-10 shrink-0 rounded-full bg-muted"
                        ></span>
                        <span class="min-w-0">
                            <span
                                class="block text-sm font-medium leading-5"
                            >
                                Template name
                            </span>
                            <span
                                class="mt-1 block text-xs leading-5"
                            >
                                1 service · 1.0
                            </span>
                        </span>
                    </span>
                    <span class="text-xs leading-5">
                        A short description of the template that spans
                        two lines.
                    </span>
                </li>
            {/each}
        </ul>
    </Skeleton>
{/snippet}

{#snippet groupHeading(
    id: string,
    title: string,
    description: string,
    count: number | null,
)}
    <div class="min-w-0">
        <div class="flex items-baseline gap-2">
            <FrameTitle class="text-base">
                <h2 {id}>{title}</h2>
            </FrameTitle>
            {#if count !== null}
                <span
                    class="text-xs tabular-nums text-muted-foreground"
                >
                    {count}
                </span>
            {/if}
        </div>
        <FrameDescription class="mt-1">
            {description}
        </FrameDescription>
    </div>
{/snippet}

<div class="flex w-full flex-col gap-6 pt-6">
    <h1 class="sr-only">New resource</h1>
    {#if project?.isInternal}
        <Alert variant="info">
            <AlertDescription>
                Stoat manages this project's internal services. New
                resources can't be added here.
            </AlertDescription>
        </Alert>
    {:else}
        <Frame role="region" aria-labelledby="group-scratch">
            <FrameHeader>
                {@render groupHeading(
                    "group-scratch",
                    "Start from scratch",
                    "",
                    null,
                )}
            </FrameHeader>
            <FramePanel class="overflow-hidden p-0">
                {@render grid(scratch)}
            </FramePanel>
        </Frame>

        {#if templatesQuery.isError}
            <Alert variant="error">
                <AlertDescription>
                    Unable to load templates: {templatesQuery.error
                        .message}
                </AlertDescription>
            </Alert>
        {:else}
            {#if templatesQuery.isPending || databases.length > 0}
                <Frame
                    role="region"
                    aria-labelledby="group-databases"
                >
                    <FrameHeader>
                        {@render groupHeading(
                            "group-databases",
                            "Databases",
                            "",
                            null,
                        )}
                    </FrameHeader>
                    <FramePanel class="overflow-hidden p-0">
                        {#if templatesQuery.isPending}
                            {@render loadingGrid("Loading databases")}
                        {:else}
                            {@render grid(databases)}
                        {/if}
                    </FramePanel>
                </Frame>
            {/if}

            {#if templatesQuery.isPending || otherTemplates.length > 0}
                <Frame
                    role="region"
                    aria-labelledby="group-templates"
                >
                    <FrameHeader
                        class="flex-row flex-wrap items-start justify-between gap-2"
                    >
                        {@render groupHeading(
                            "group-templates",
                            "Templates",
                            "",
                            null,
                        )}
                        <div
                            class="flex w-full flex-wrap items-center gap-2 sm:w-auto"
                        >
                            <InputGroup class="w-full sm:w-56">
                                <InputGroupInput
                                    type="search"
                                    placeholder="Search templates"
                                    aria-label="Search templates"
                                    bind:value={filters.q.current}
                                    disabled={templatesQuery.isPending}
                                />
                                <InputGroupAddon align="inline-start">
                                    <Search aria-hidden="true" />
                                </InputGroupAddon>
                            </InputGroup>
                            {#if tags.length > 1}
                                <Select
                                    value={filters.tag.current}
                                    items={[
                                        {
                                            value: "all",
                                            label: "All categories",
                                        },
                                        ...tags.map((value) => ({
                                            value,
                                            label:
                                                value[0].toUpperCase() +
                                                value.slice(1),
                                        })),
                                    ]}
                                    onValueChange={(value) =>
                                        (filters.tag.current =
                                            value ?? "all")}
                                >
                                    <SelectTrigger
                                        size="sm"
                                        class="w-auto"
                                        aria-label="Filter templates by category"
                                    >
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem
                                            value="all"
                                            label="All categories"
                                        />
                                        {#each tags as value (value)}<SelectItem
                                                {value}
                                                label={value[0].toUpperCase() +
                                                    value.slice(1)}
                                            />{/each}
                                    </SelectContent>
                                </Select>
                            {/if}
                        </div>
                    </FrameHeader>
                    <FramePanel class="overflow-hidden p-0">
                        {#if templatesQuery.isPending}
                            {@render loadingGrid("Loading templates")}
                        {:else if visibleTemplates.length === 0}
                            <Empty
                                class="m-3 rounded-xl border border-dashed border-border p-4 md:py-8"
                            >
                                <EmptyHeader>
                                    <EmptyDescription>
                                        No templates match your
                                        filters.
                                    </EmptyDescription>
                                </EmptyHeader>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onclick={clearFilters}
                                >
                                    Clear filters
                                </Button>
                            </Empty>
                        {:else}
                            {@render grid(visibleTemplates)}
                        {/if}
                    </FramePanel>
                </Frame>
            {/if}
        {/if}
    {/if}
</div>
