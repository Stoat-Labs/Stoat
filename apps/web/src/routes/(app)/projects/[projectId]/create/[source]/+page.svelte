<script lang="ts">
    import { goto } from "$app/navigation";
    import { page } from "$app/state";
    import GitSourceFields from "$lib/components/projects/git-source-fields.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Empty,
        EmptyContent,
        EmptyDescription,
        EmptyHeader,
        EmptyMedia,
        EmptyTitle,
    } from "$lib/components/ui/empty";
    import { Field } from "$lib/components/ui/field";
    import {
        Frame,
        FrameDescription,
        FrameFooter,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import {
        segmentedControlItemVariants,
        segmentedControlRootClassName,
    } from "$lib/components/ui/tabs/segmented-control";
    import { Textarea } from "$lib/components/ui/textarea";
    import { orpc, queryClient } from "$lib/orpc";
    import { cn } from "$lib/utils";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import ImageIcon from "$lib/components/image-icon.svelte";
    import Container from "@lucide/svelte/icons/container";
    import GitBranch from "@lucide/svelte/icons/git-branch";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import KeyRound from "@lucide/svelte/icons/key-round";
    import LayoutTemplate from "@lucide/svelte/icons/layout-template";
    import X from "@lucide/svelte/icons/x";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import {
        parseAsBoolean,
        parseAsString,
        useQueryStates,
    } from "nuqs-svelte";
    import { watch } from "runed";
    import { onDestroy } from "svelte";

    const projectId = $derived(page.params.projectId ?? "");

    const source = $derived(page.params.source ?? "");

    const fromGit = $derived(source === "git");

    const fromTemplate = $derived(
        source !== "compose" && source !== "git",
    );

    const backHref = $derived(`/projects/${projectId}/create`);

    const projectQuery = createQuery(() =>
        orpc.projects.getProject.queryOptions({
            input: { projectId },
            enabled: projectId.length > 0,
        }),
    );

    const project = $derived(projectQuery.data);

    const templatesQuery = createQuery(() =>
        orpc.resources.listTemplates.queryOptions({
            enabled: fromTemplate,
        }),
    );

    const template = $derived(
        fromTemplate
            ? templatesQuery.data?.find((t) => t.appId === source)
            : undefined,
    );

    const fields = useQueryStates(
        {
            name: parseAsString,
            description: parseAsString.withDefault(""),
            showDescription: parseAsBoolean,
            templateVersion: parseAsString.withDefault(""),
            connectionId: parseAsString.withDefault(""),
            repositoryUrl: parseAsString.withDefault(""),
            branch: parseAsString.withDefault(""),
            path: parseAsString.withDefault("."),
        },
        { history: "replace", shallow: true, scroll: false },
    );

    // Resolve async template defaults without overwriting a restored URL draft.
    const name = $derived(
        fields.name.current ?? template?.name ?? "",
    );

    const showDescription = $derived(
        (fields.showDescription.current ?? !fromTemplate) ||
            Boolean(fields.description.current),
    );

    // Template inputs may contain secrets and must stay out of the URL.
    let variables = $state<Record<string, string>>({});

    // Path the in-flight create was submitted from. A slow request must not
    // navigate after the user has moved on to another page or template.
    let submittedFrom = "";

    let active = true;

    onDestroy(() => {
        active = false;
    });

    const version = $derived(
        template?.versions.find(
            (v) => v.version === fields.templateVersion.current,
        ) ?? template?.versions[0],
    );

    // SvelteKit reuses this page across projects/sources. Only reset local state;
    // nuqs restores the destination's query parameters, including on Back/Forward.
    watch(
        () => page.url.pathname,
        () => {
            variables = {};
            createMutationState.reset();
        },
    );

    const createMutationState = createMutation(() =>
        orpc.resources.createResource.mutationOptions({
            onSuccess: async (resource, input) => {
                await queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.queryKey({
                        input: { projectId: input.projectId },
                    }),
                });
                void queryClient.invalidateQueries({
                    queryKey: orpc.projects.key(),
                });

                if (
                    resource &&
                    active &&
                    page.url.pathname === submittedFrom
                )
                    await goto(
                        `/projects/${input.projectId}/${resource.id}`,
                    );
            },
        }),
    );

    const pending = $derived(createMutationState.isPending);

    const canSubmit = $derived(
        Boolean(name.trim()) &&
            !pending &&
            (!fromGit ||
                Boolean(
                    fields.connectionId.current &&
                    fields.repositoryUrl.current &&
                    fields.branch.current.trim() &&
                    fields.path.current.trim(),
                )) &&
            (!fromTemplate ||
                Boolean(
                    version &&
                    version.required.every((key) =>
                        variables[key]?.trim(),
                    ),
                )),
    );

    function createResource(event: SubmitEvent) {
        event.preventDefault();

        if (!canSubmit) return;

        submittedFrom = page.url.pathname;
        createMutationState.mutate({
            projectId,
            name: name.trim(),
            description:
                fields.description.current.trim() || undefined,
            type: "compose",
            git: fromGit
                ? {
                      connectionId: fields.connectionId.current,
                      repositoryUrl: fields.repositoryUrl.current,
                      branch: fields.branch.current.trim(),
                      path: fields.path.current.trim(),
                  }
                : undefined,
            template:
                template && version
                    ? {
                          appId: template.appId,
                          version: version.version,
                          variables: Object.fromEntries(
                              version.required.map((key) => [
                                  key,
                                  variables[key]?.trim() ?? "",
                              ]),
                          ),
                      }
                    : undefined,
        });
    }

    const heading = $derived(
        template
            ? {
                  title: template.name,
                  description: template.description,
                  badge: "Template",
              }
            : fromGit
              ? {
                    title: "Compose from Git",
                    description:
                        "Deploy a Docker Compose file from a connected repository.",
                    badge: "Git",
                }
              : {
                    title: "New Compose",
                    description:
                        "Start with an empty Docker Compose spec.",
                    badge: "Compose",
                },
    );

    const HeadingIcon = $derived(
        fromTemplate
            ? LayoutTemplate
            : fromGit
              ? GitBranch
              : Container,
    );
</script>

<svelte:head>
    <title>
        {template?.name ?? heading.title} / {project?.name ??
            "Project"} / Stoat
    </title>
</svelte:head>

<div class="flex w-full flex-col gap-6 pt-6">
    {#if fromTemplate && templatesQuery.isPending}
        <Skeleton loading loading-label="Loading template">
            <div class="flex flex-col gap-6">
                <div class="flex items-center gap-3">
                    <span class="size-8 rounded-lg bg-muted"></span>
                    <span class="size-14 rounded-lg bg-muted"></span>
                    <div>
                        <h1 class="text-2xl font-semibold">
                            Template
                        </h1>
                        <p class="mt-1 text-sm">
                            A short description.
                        </p>
                    </div>
                </div>
                <div class="grid gap-6 xl:grid-cols-5">
                    <div
                        class="min-h-96 rounded-2xl bg-muted xl:col-span-3"
                    ></div>
                    <div
                        class="min-h-64 rounded-2xl bg-muted xl:col-span-2"
                    ></div>
                </div>
            </div>
        </Skeleton>
    {:else if fromTemplate && templatesQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load templates: {templatesQuery.error
                    .message}
            </AlertDescription>
        </Alert>
    {:else if fromTemplate && !template}
        <Empty class="rounded-xl border border-dashed border-border">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <LayoutTemplate aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>Template not found</EmptyTitle>
                <EmptyDescription>
                    There's no template called “{source}”.
                </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
                <Button size="sm" href={backHref}>
                    <ArrowLeft class="size-4" aria-hidden="true" />
                    Back to templates
                </Button>
            </EmptyContent>
        </Empty>
    {:else if project?.isInternal}
        <Alert variant="info">
            <AlertDescription>
                Stoat manages this project's internal services. New
                resources can't be added here.
            </AlertDescription>
        </Alert>
    {:else}
        <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="flex min-w-0 items-start gap-3">
                <Button
                    variant="ghost"
                    size="icon-sm"
                    href={backHref}
                    aria-label="Back to new resource"
                >
                    <ArrowLeft aria-hidden="true" />
                </Button>
                {#if template?.logo}
                    <img
                        src={template.logo}
                        alt=""
                        class="size-14 shrink-0 object-contain"
                    />
                {:else}
                    <HeadingIcon
                        class="size-14 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                    />
                {/if}
                <div class="min-w-0">
                    <h1 class="text-2xl font-semibold break-anywhere">
                        {heading.title}
                    </h1>
                    <p class="mt-1 text-sm text-muted-foreground">
                        {heading.description}
                    </p>
                </div>
            </div>
            <Badge variant="secondary" size="lg">
                {heading.badge}
            </Badge>
        </div>

        <div
            class={cn(
                "grid items-start gap-6",
                version && "xl:grid-cols-5",
            )}
        >
            <form
                method="POST"
                onsubmit={createResource}
                aria-busy={pending}
                class={cn(
                    "flex min-w-0 self-stretch",
                    version
                        ? "xl:col-span-3"
                        : "mx-auto w-full max-w-2xl",
                )}
            >
                <Frame
                    class="min-w-0 flex-1"
                    role="region"
                    aria-labelledby="resource-heading"
                >
                    <FrameHeader>
                        <FrameTitle class="text-base">
                            <h2 id="resource-heading">Resource</h2>
                        </FrameTitle>
                        <FrameDescription class="mt-1">
                            {fromTemplate
                                ? "Pick a version and fill in what the template needs."
                                : "Name it now; you can edit the spec after it's created."}
                        </FrameDescription>
                    </FrameHeader>
                    <div class="space-y-4 px-5 py-4">
                        {#if createMutationState.isError}
                            <Alert variant="error" role="alert">
                                <AlertDescription>
                                    {createMutationState.error
                                        .message ||
                                        "Unable to create resource."}
                                </AlertDescription>
                            </Alert>
                        {/if}
                        {#if template && template.versions.length > 1}
                            {#if template.versions.length <= 4}
                                <fieldset disabled={pending}>
                                    <legend
                                        class="mb-2 text-sm font-medium"
                                    >
                                        Version
                                    </legend>
                                    <div
                                        class={cn(
                                            segmentedControlRootClassName,
                                            "w-full",
                                        )}
                                    >
                                        {#each template.versions as v (v.version)}
                                            <label
                                                class={cn(
                                                    segmentedControlItemVariants(),
                                                    "flex-1 has-checked:bg-background has-checked:text-foreground has-checked:shadow-sm/5 has-focus-visible:outline-ring dark:has-checked:bg-input",
                                                )}
                                            >
                                                <input
                                                    type="radio"
                                                    name="template-version"
                                                    class="sr-only"
                                                    value={v.version}
                                                    checked={v.version ===
                                                        version?.version}
                                                    onchange={() =>
                                                        (fields.templateVersion.current =
                                                            v.version)}
                                                />
                                                {v.version}
                                            </label>
                                        {/each}
                                    </div>
                                </fieldset>
                            {:else}
                                <Field>
                                    <Label
                                        for="template-version"
                                        required
                                    >
                                        Version
                                    </Label>
                                    <Select
                                        value={version?.version}
                                        items={template.versions.map(
                                            (v) => ({
                                                value: v.version,
                                                label: v.version,
                                            }),
                                        )}
                                        disabled={pending}
                                        onValueChange={(value) =>
                                            (fields.templateVersion.current =
                                                value ?? "")}
                                    >
                                        <SelectTrigger
                                            id="template-version"
                                        >
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {#each template.versions as v (v.version)}<SelectItem
                                                    value={v.version}
                                                    label={v.version}
                                                />{/each}
                                        </SelectContent>
                                    </Select>
                                </Field>
                            {/if}
                        {/if}
                        <Field>
                            <div
                                class="flex w-full items-center justify-between gap-2"
                            >
                                <Label for="resource-name" required>
                                    Name
                                </Label>
                                {#if !showDescription}
                                    <Button
                                        variant="ghost"
                                        size="xs"
                                        class="-me-1.5 text-muted-foreground"
                                        disabled={pending}
                                        onclick={() =>
                                            (fields.showDescription.current = true)}
                                    >
                                        + Add description
                                    </Button>
                                {/if}
                            </div>
                            <Input
                                id="resource-name"
                                bind:value={
                                    () => name,
                                    (value) =>
                                        (fields.name.current = value)
                                }
                                placeholder="My service"
                                required
                                maxlength={100}
                                disabled={pending}
                            />
                        </Field>
                        {#if showDescription}
                            <Field class="group/description">
                                <div
                                    class="flex w-full items-center justify-between gap-2"
                                >
                                    <Label for="resource-description">
                                        Description
                                    </Label>
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="xs"
                                        class="-me-1.5 text-muted-foreground opacity-0 transition-opacity group-hover/description:opacity-100 group-focus-within/description:opacity-100 [@media(hover:none)]:opacity-100"
                                        aria-label="Remove description"
                                        disabled={pending}
                                        onclick={() => {
                                            void fields.set({
                                                description: null,
                                                showDescription: false,
                                            });
                                            document
                                                .getElementById(
                                                    "resource-name",
                                                )
                                                ?.focus();
                                        }}
                                    >
                                        <X aria-hidden="true" />
                                        Remove description
                                    </Button>
                                </div>
                                <Textarea
                                    id="resource-description"
                                    bind:value={
                                        fields.description.current
                                    }
                                    placeholder="What is this resource for?"
                                    maxlength={500}
                                    rows={2}
                                    disabled={pending}
                                />
                            </Field>
                        {/if}
                        {#if fromGit}
                            <GitSourceFields
                                bind:connectionId={
                                    fields.connectionId.current
                                }
                                bind:repositoryUrl={
                                    fields.repositoryUrl.current
                                }
                                bind:branch={fields.branch.current}
                                bind:path={fields.path.current}
                                disabled={pending}
                            />
                        {/if}
                    </div>
                    {#if version && version.required.length > 0}
                        <div class="space-y-4 px-5 py-4">
                            <div class="flex items-baseline gap-2">
                                <h3 class="text-sm font-semibold">
                                    Variables
                                </h3>
                                <span
                                    class="text-xs tabular-nums text-muted-foreground"
                                >
                                    {version.required.length} required
                                </span>
                            </div>
                            {#each version.required as key (key)}
                                <Field>
                                    <Label
                                        for="template-variable-{key}"
                                        required
                                        class="font-mono"
                                    >
                                        {key}
                                    </Label>
                                    <Input
                                        id="template-variable-{key}"
                                        bind:value={
                                            () =>
                                                variables[key] ?? "",
                                            (value) =>
                                                (variables[key] =
                                                    value)
                                        }
                                        required
                                        autocomplete="off"
                                        spellcheck="false"
                                        class="font-mono"
                                        maxlength={4096}
                                        disabled={pending}
                                    />
                                </Field>
                            {/each}
                        </div>
                    {/if}
                    <FrameFooter
                        class="mt-auto flex flex-wrap items-center justify-end gap-2 px-4 py-3"
                    >
                        <Button
                            variant="outline"
                            href={backHref}
                            disabled={pending}
                        >
                            Cancel
                        </Button>
                        <Button
                            type="submit"
                            loading={pending}
                            disabled={!canSubmit}
                        >
                            Create resource
                        </Button>
                    </FrameFooter>
                </Frame>
            </form>

            {#if version}
                <aside class="min-w-0 xl:col-span-2">
                    {@render templateContents(version)}
                </aside>
            {/if}
        </div>
    {/if}
</div>

{#snippet templateContents(v: {
    services: {
        name: string;
        image: string | null;
        volumes: { source: string | null; target: string }[];
    }[];
    secrets: string[];
})}
    <Frame role="region" aria-labelledby="services-heading">
        <FrameHeader>
            <div class="flex items-baseline gap-2">
                <FrameTitle class="text-base">
                    <h2 id="services-heading">Services</h2>
                </FrameTitle>
                <span
                    class="text-xs tabular-nums text-muted-foreground"
                >
                    {v.services.length}
                </span>
            </div>
            <FrameDescription class="mt-1">
                What this version deploys.
            </FrameDescription>
        </FrameHeader>
        <FramePanel class="divide-y divide-border p-0">
            {#each v.services as service (service.name)}
                <div
                    class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 p-3"
                >
                    <ImageIcon image={service.image} />
                    <div class="min-w-0">
                        <h3
                            class="truncate text-sm font-medium leading-5"
                        >
                            {service.name}
                        </h3>
                        {#if service.image}
                            <p
                                class="mt-1 truncate font-mono text-xs leading-5 text-muted-foreground"
                                title={service.image}
                            >
                                {service.image}
                            </p>
                        {/if}
                    </div>
                    {#if service.volumes.length > 0}
                        <ul
                            class="col-start-2 flex min-w-0 flex-wrap gap-1"
                            aria-label="Volumes"
                        >
                            {#each service.volumes as volume (volume.target)}
                                <li class="max-w-full">
                                    <Badge
                                        variant="outline"
                                        class="max-w-full font-mono font-normal text-muted-foreground"
                                        title={volume.source
                                            ? `${volume.source}:${volume.target}`
                                            : volume.target}
                                    >
                                        <HardDrive
                                            aria-hidden="true"
                                        />
                                        <span class="truncate">
                                            {volume.target}
                                        </span>
                                    </Badge>
                                </li>
                            {/each}
                        </ul>
                    {/if}
                </div>
            {/each}
        </FramePanel>
        {#if v.secrets.length > 0}
            <FrameFooter class="space-y-2 px-4 py-3">
                <p
                    class="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                    <KeyRound class="size-3.5" aria-hidden="true" />
                    {v.secrets.length}
                    {v.secrets.length === 1 ? "secret" : "secrets"} generated,
                    editable later in Variables
                </p>
                <ul class="flex flex-wrap gap-1">
                    {#each v.secrets as secret (secret)}
                        <li>
                            <Badge
                                variant="secondary"
                                class="font-mono font-normal"
                            >
                                {secret}
                            </Badge>
                        </li>
                    {/each}
                </ul>
            </FrameFooter>
        {/if}
    </Frame>
{/snippet}
