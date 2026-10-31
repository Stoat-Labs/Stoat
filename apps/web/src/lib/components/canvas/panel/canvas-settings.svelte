<script lang="ts">
    import { page } from "$app/state";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Input } from "$lib/components/ui/input";
    import { Kbd } from "$lib/components/ui/kbd";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { GitSourceActions } from "$lib/resources/git-source-actions.svelte";
    import Code from "@lucide/svelte/icons/code";
    import Flame from "@lucide/svelte/icons/flame";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import Network from "@lucide/svelte/icons/network";
    import Rocket from "@lucide/svelte/icons/rocket";
    import SlidersHorizontal from "@lucide/svelte/icons/sliders-horizontal";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsString, useQueryState } from "nuqs-svelte";
    import type { Component } from "svelte";
    import * as v from "valibot";
    import type { CanvasResource, CanvasService } from "../graph";
    import SettingsDanger from "./settings/settings-danger.svelte";
    import SettingsDeploy from "./settings/settings-deploy.svelte";
    import SettingsGeneral from "./settings/settings-general.svelte";
    import SettingsNetworking from "./settings/settings-networking.svelte";
    import SettingsSource from "./settings/settings-source.svelte";
    import SettingsStorage from "./settings/settings-storage.svelte";

    let {
        resource,
        services,
    }: {
        resource: CanvasResource;
        services: CanvasService[];
    } = $props();

    const input = $derived({
        projectId: resource.projectId,
        resourceId: resource.id,
    });

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({ input }),
    );

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId: resource.projectId },
        }),
    );

    const details = $derived(resourceQuery.data);

    const isBucket = $derived(resource.type === "bucket");

    const isAdmin = $derived(page.data.isOrganizationAdmin === true);

    // System-managed resources keep their source and cannot be deleted.
    // Treated as internal until the project loads, so Source and Delete never flash for one.
    const isInternal = $derived(
        !projectQuery.isSuccess ||
            projectQuery.data.isInternal === true,
    );

    const git = new GitSourceActions(
        () => resource.projectId,
        () => resource.id,
        () => details,
    );

    const envSchema = v.fallback(
        v.object({ env: v.fallback(v.string(), "") }),
        { env: "" },
    );

    // Networking and Deploy both edit the Compose draft; the next deploy publishes it.
    const draftCompose = $derived(details?.draftSpec ?? "");

    const env = $derived(v.parse(envSchema, details?.settings).env);

    let savingDraft = $state(false);

    /** Saves the Compose draft; resolves to the error message, or null once saved. */
    async function saveDraft(compose: string) {
        if (!details) return "The resource is still loading.";

        savingDraft = true;

        try {
            const updated = await client.resources.updateComposeSpec({
                ...input,
                spec: compose,
                expectedSpec: details.draftSpec,
                expectedSource: git.savedSource
                    ? { ...git.savedSource }
                    : null,
            });

            queryClient.setQueryData(
                orpc.resources.getResource.queryKey({ input }),
                updated,
            );
            await queryClient.invalidateQueries({
                queryKey: orpc.resources.getProjectGraph.key(),
            });

            return null;
        } catch (cause) {
            return cause instanceof Error
                ? cause.message
                : "Unable to update the Compose file.";
        } finally {
            savingDraft = false;
        }
    }

    // Railway's settings search; kept in the URL like the open tab.
    const filter = useQueryState(
        "settingsFilter",
        parseAsString
            .withDefault("")
            .withOptions({ shallow: true, scroll: false }),
    );

    const needle = $derived(filter.current.trim().toLowerCase());

    function shows(...words: string[]) {
        return (
            !needle ||
            words.some((word) => word.toLowerCase().includes(needle))
        );
    }

    type Section = {
        id: string;
        title: string;
        icon: Component;
        visible: boolean;
    };

    const sections: Section[] = $derived([
        {
            id: "source",
            title: "Source",
            icon: Code,
            visible:
                !isBucket &&
                !isInternal &&
                shows(
                    "source",
                    "repo",
                    "git",
                    "branch",
                    "compose file",
                    "watch directory",
                    "auto deploy",
                    "pull",
                    "push",
                    "commit",
                ),
        },
        {
            id: "networking",
            title: "Networking",
            icon: Network,
            visible:
                !isBucket &&
                shows(
                    "networking",
                    "public",
                    "domain",
                    "port",
                    "private",
                    "internal",
                    "dns",
                ),
        },
        {
            id: "deploy",
            title: "Deploy",
            icon: Rocket,
            visible:
                !isBucket &&
                shows(
                    "deploy",
                    "prefix names",
                    "compose",
                    "update order",
                    "stop first",
                    "start first",
                ),
        },
        {
            id: "general",
            title: "General",
            icon: SlidersHorizontal,
            visible: shows(
                "general",
                "name",
                "rename",
                "icon",
                "project",
                "move",
                "copy",
                "duplicate",
            ),
        },
        {
            id: "storage",
            title: "Storage",
            icon: HardDrive,
            visible: isBucket && shows("storage", "limit", "quota"),
        },
        {
            id: "danger",
            title: "Danger",
            icon: Flame,
            visible:
                isAdmin && !isInternal && shows("danger", "delete"),
        },
    ]);

    const visibleSections = $derived(
        sections.filter((section) => section.visible),
    );

    let filterInput = $state<HTMLInputElement | null>(null);

    function jump(id: string) {
        document
            .getElementById(`settings-${id}`)
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
</script>

<svelte:window
    onkeydown={(event) => {
        // Railway focuses the settings filter on "/", unless something else has focus.
        if (
            event.key === "/" &&
            event.target instanceof HTMLElement &&
            !event.target.closest(
                "input, textarea, [contenteditable]",
            )
        ) {
            event.preventDefault();
            filterInput?.focus();
        }
    }}
/>

{#snippet body(id: string)}
    {#if id === "source"}
        <SettingsSource {git} {isAdmin} {shows} />
    {:else if id === "networking"}
        <SettingsNetworking
            {resource}
            {services}
            {draftCompose}
            {env}
            {isInternal}
            {savingDraft}
            {saveDraft}
            {shows}
        />
    {:else if id === "deploy"}
        <SettingsDeploy
            {resource}
            {services}
            settings={details?.settings}
            {draftCompose}
            {isInternal}
            {savingDraft}
            {saveDraft}
        />
    {:else if id === "general"}
        <SettingsGeneral {resource} {isBucket} {isInternal} {shows} />
    {:else if id === "storage"}
        <SettingsStorage {resource} {isAdmin} />
    {:else}
        <SettingsDanger {resource} {isBucket} />
    {/if}
{/snippet}

<div class="@container flex min-h-full flex-col">
    <!-- Railway's filter bar, pinned under the tabs. -->
    <div
        class="sticky top-0 z-10 border-b bg-card/70 backdrop-blur-lg px-3 py-3"
    >
        <div class="relative">
            <Input
                bind:ref={filterInput}
                value={filter.current}
                oninput={(event) =>
                    void filter.set(
                        event.currentTarget.value || null,
                    )}
                placeholder="Filter settings..."
                aria-label="Filter settings"
                class="[&_input]:pr-9"
            />
            <Kbd
                class="absolute top-1/2 right-2 z-10 -translate-y-1/2"
            >
                /
            </Kbd>
        </div>
    </div>

    {#if resourceQuery.isPending}
        <Skeleton loading label="Loading settings" class="px-7 pt-10">
            <div class="space-y-6 pl-16">
                <p class="text-xl">Source</p>
                <div class="h-16 rounded-md border"></div>
                <div class="h-16 rounded-md border"></div>
            </div>
        </Skeleton>
    {:else if resourceQuery.isError}
        <Alert variant="error" class="m-7">
            <AlertDescription>
                Unable to load settings: {resourceQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else}
        <div class="flex flex-1 gap-12 px-7 pt-10">
            <!-- Railway's timeline: one icon per section on a thin vertical rule. -->
            <div
                class="relative flex min-w-0 max-w-[600px] flex-1 flex-col"
            >
                <div
                    class="absolute top-5 bottom-0 left-5 w-px bg-border"
                    aria-hidden="true"
                ></div>
                {#each visibleSections as section (section.id)}
                    <section
                        id="settings-{section.id}"
                        class="relative scroll-mt-20 pb-14 pl-16"
                        aria-labelledby="settings-{section.id}-title"
                    >
                        <span
                            class={[
                                "absolute top-0 left-0 flex size-10 items-center justify-center rounded-full border bg-card",
                                section.id === "danger"
                                    ? "text-destructive-foreground"
                                    : "text-muted-foreground",
                            ]}
                            aria-hidden="true"
                        >
                            <section.icon class="size-4" />
                        </span>
                        {#if section.id !== "danger"}
                            <h3
                                id="settings-{section.id}-title"
                                class="flex h-10 items-center text-xl text-muted-foreground"
                            >
                                {section.title}
                            </h3>
                        {:else}
                            <h3
                                id="settings-{section.id}-title"
                                class="sr-only"
                            >
                                {section.title}
                            </h3>
                        {/if}
                        <div
                            class={[
                                "space-y-8",
                                section.id === "danger"
                                    ? "pt-2"
                                    : "pt-6",
                            ]}
                        >
                            {@render body(section.id)}
                        </div>
                    </section>
                {:else}
                    <p class="pl-16 text-sm text-muted-foreground">
                        No settings match "{filter.current}".
                    </p>
                {/each}
            </div>

            <!-- Railway's section rail, only where the panel is wide enough. -->
            <nav
                class="sticky top-24 hidden h-fit w-36 shrink-0 @3xl:block"
                aria-label="Settings sections"
            >
                <ul class="space-y-3 text-sm text-muted-foreground">
                    {#each visibleSections as section (section.id)}
                        <li>
                            <button
                                type="button"
                                class="transition-colors hover:text-foreground"
                                onclick={() => jump(section.id)}
                            >
                                {section.title}
                            </button>
                        </li>
                    {/each}
                </ul>
            </nav>
        </div>
    {/if}
</div>
