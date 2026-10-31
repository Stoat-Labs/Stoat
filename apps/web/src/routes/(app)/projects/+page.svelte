<script lang="ts">
    import ProjectOverviewCard from "$lib/components/home/project-overview-card.svelte";
    import CreateProjectDialog from "$lib/components/projects/create-project-dialog.svelte";
    import ProjectCard, {
        placeholderResources,
    } from "$lib/components/projects/project-card.svelte";
    import {
        Alert,
        AlertAction,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import {
        Button,
        buttonVariants,
    } from "$lib/components/ui/button";
    import {
        Empty,
        EmptyContent,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import {
        InputGroup,
        InputGroupAddon,
        InputGroupInput,
    } from "$lib/components/ui/input-group";
    import { Kbd, KbdGroup } from "$lib/components/ui/kbd";
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import { Separator } from "$lib/components/ui/separator";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        segmentedControlItemVariants,
        segmentedControlRootClassName,
    } from "$lib/components/ui/tabs/segmented-control";
    import { orpc } from "$lib/api/orpc";
    import Check from "@lucide/svelte/icons/check";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import FolderOpen from "@lucide/svelte/icons/folder-open";
    import LayoutGrid from "@lucide/svelte/icons/layout-grid";
    import List from "@lucide/svelte/icons/list";
    import Plus from "@lucide/svelte/icons/plus";
    import Search from "@lucide/svelte/icons/search";
    import { createQuery } from "@tanstack/svelte-query";
    import {
        parseAsString,
        parseAsStringLiteral,
        useQueryStates,
    } from "nuqs-svelte";
    import { onMount } from "svelte";

    const sortOptions = [
        { value: "recent", label: "Recent Activity" },
        { value: "name", label: "Name" },
        { value: "created", label: "Date Created" },
    ] as const;

    const viewOptions = [
        { value: "grid", label: "Grid view", icon: LayoutGrid },
        { value: "list", label: "List view", icon: List },
    ] as const;

    const params = useQueryStates(
        {
            dialog: parseAsString,
            q: parseAsString.withDefault(""),
            sort: parseAsStringLiteral([
                "recent",
                "name",
                "created",
            ]).withDefault("recent"),
            view: parseAsStringLiteral(["grid", "list"]).withDefault(
                "grid",
            ),
        },
        { shallow: true, scroll: false },
    );

    const projectsQuery = createQuery(() =>
        orpc.projects.listProjectOverviews.queryOptions(),
    );

    const all = $derived(projectsQuery.data ?? []);

    // Starred projects lead, then Railway's chosen order.
    const projects = $derived.by(() => {
        const q = params.q.current.trim().toLowerCase();

        return all
            .filter(
                (project) =>
                    !q ||
                    [
                        project.name,
                        project.description ?? "",
                        ...project.resources.map(
                            (resource) => resource.name,
                        ),
                    ].some((value) =>
                        value.toLowerCase().includes(q),
                    ),
            )
            .toSorted((a, b) => {
                if (a.favorite !== b.favorite)
                    return a.favorite ? -1 : 1;

                if (params.sort.current === "name")
                    return a.name.localeCompare(b.name);

                if (params.sort.current === "created")
                    return (
                        new Date(b.createdAt).getTime() -
                        new Date(a.createdAt).getTime()
                    );

                return (
                    new Date(b.lastActivityAt).getTime() -
                    new Date(a.lastActivityAt).getTime()
                );
            });
    });

    const listClass = $derived(
        params.view.current === "list"
            ? "flex flex-col gap-2"
            : "grid gap-4 sm:grid-cols-2 lg:grid-cols-3",
    );

    let search = $state<HTMLInputElement | null>(null);

    let ready = $state(false);

    onMount(() => {
        ready = true;

        return () => {
            ready = false;
        };
    });

    function openCreate() {
        void params.set({ dialog: "create-project" });
    }
</script>

<svelte:head><title>Projects / Stoat</title></svelte:head>

<svelte:window
    onkeydown={(event) => {
        // Railway's Ctrl K jumps to the project search.
        if (
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === "k"
        ) {
            event.preventDefault();
            search?.focus();
        }
    }}
/>

<div class="mx-auto w-full max-w-6xl space-y-6 pt-8">
    <header class="flex flex-wrap items-center justify-between gap-4">
        <h1 class="text-3xl tracking-tight">Projects</h1>
        <div class="flex w-full items-center gap-3 sm:w-auto">
            <InputGroup class="min-w-0 flex-1 sm:w-64 sm:flex-none">
                <InputGroupInput
                    bind:ref={search}
                    value={params.q.current}
                    oninput={(event) =>
                        void params.set({
                            q: event.currentTarget.value || null,
                        })}
                    placeholder="Search projects..."
                    aria-label="Search projects"
                />
                <InputGroupAddon align="inline-start">
                    <Search aria-hidden="true" />
                </InputGroupAddon>
                <InputGroupAddon
                    align="inline-end"
                    class="hidden sm:flex"
                >
                    <KbdGroup>
                        <Kbd>Ctrl</Kbd>
                        <Kbd>K</Kbd>
                    </KbdGroup>
                </InputGroupAddon>
            </InputGroup>
            <Button
                disabled={!ready}
                onclick={openCreate}
                aria-label="New project"
            >
                <Plus class="size-4" aria-hidden="true" />
                New
            </Button>
        </div>
    </header>

    <div class="flex flex-wrap items-center justify-between gap-3">
        <div
            class="flex items-center gap-3 text-sm text-muted-foreground"
        >
            <p class="flex items-center gap-2">
                <LayoutGrid class="size-4" aria-hidden="true" />
                <span class="text-foreground tabular-nums">
                    {all.length}
                    {all.length === 1 ? "Project" : "Projects"}
                </span>
            </p>
            <Separator orientation="vertical" class="h-5" />
            <Menu>
                <MenuTrigger
                    class={buttonVariants({
                        variant: "ghost",
                        size: "sm",
                        class: "-ms-2 font-normal text-muted-foreground data-popup-open:bg-accent",
                    })}
                >
                    Sort By: {sortOptions.find(
                        (option) =>
                            option.value === params.sort.current,
                    )?.label}
                    <ChevronDown
                        class="size-3.5"
                        aria-hidden="true"
                    />
                </MenuTrigger>
                <MenuPopup align="start" class="min-w-44">
                    {#each sortOptions as option (option.value)}
                        <MenuItem
                            onclick={() =>
                                void params.set({
                                    sort:
                                        option.value === "recent"
                                            ? null
                                            : option.value,
                                })}
                        >
                            <span class="flex-1">{option.label}</span>
                            {#if params.sort.current === option.value}
                                <Check
                                    class="size-4"
                                    aria-hidden="true"
                                />
                            {/if}
                        </MenuItem>
                    {/each}
                </MenuPopup>
            </Menu>
        </div>
        <div class={segmentedControlRootClassName} aria-label="View">
            {#each viewOptions as option (option.value)}
                <button
                    type="button"
                    class={segmentedControlItemVariants({
                        size: "sm",
                        state: "checked",
                    })}
                    data-checked={params.view.current ===
                        option.value || undefined}
                    aria-pressed={params.view.current ===
                        option.value}
                    aria-label={option.label}
                    onclick={() =>
                        void params.set({
                            view:
                                option.value === "grid"
                                    ? null
                                    : option.value,
                        })}
                >
                    <option.icon aria-hidden="true" />
                </button>
            {/each}
        </div>
    </div>

    {#if projectsQuery.isPending}
        <Skeleton loading loading-label="Loading projects">
            <ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {#each { length: 3 }, index (index)}
                    <li>
                        <ProjectCard
                            name="Project workspace"
                            resources={placeholderResources}
                        />
                    </li>
                {/each}
            </ul>
        </Skeleton>
    {:else if projectsQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load projects: {projectsQuery.error.message}
            </AlertDescription>
            <AlertAction>
                <Button
                    size="sm"
                    variant="outline"
                    loading={projectsQuery.isFetching}
                    onclick={() => projectsQuery.refetch()}
                >
                    Retry
                </Button>
            </AlertAction>
        </Alert>
    {:else if all.length === 0}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <FolderOpen aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>No projects yet</EmptyTitle>
                <EmptyDescription>
                    Create your first project to get started.
                </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
                <Button
                    size="sm"
                    disabled={!ready}
                    onclick={openCreate}
                >
                    <Plus class="size-4" aria-hidden="true" />
                    New project
                </Button>
            </EmptyContent>
        </Empty>
    {:else if projects.length === 0}
        <p
            class="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground"
        >
            No projects match "{params.q.current}".
        </p>
    {:else}
        <ul class={listClass}>
            {#each projects as project (project.id)}
                <li class="min-w-0">
                    <ProjectOverviewCard
                        {project}
                        layout={params.view.current}
                    />
                </li>
            {/each}
        </ul>
    {/if}
</div>

<CreateProjectDialog
    bind:open={
        () => params.dialog.current === "create-project",
        (open) => {
            if (
                ready &&
                !open &&
                params.dialog.current === "create-project"
            )
                void params.set({ dialog: null });
        }
    }
/>
