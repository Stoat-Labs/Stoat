<script module lang="ts">
    import { parseAsString, parseAsStringLiteral } from "nuqs-svelte";

    export const resourceFormParsers = {
        resourceName: parseAsString.withDefault(""),
        resourceDescription: parseAsString.withDefault(""),
        source: parseAsStringLiteral(["blank", "git", "template"]).withDefault("blank"),
        template: parseAsString.withDefault(""),
    };
</script>

<script lang="ts">
    import { page } from "$app/state";
    import GitSourceFields from "./git-source-fields.svelte";
    import { Alert, AlertDescription } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import { Field } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Badge } from "$lib/components/ui/badge";
    import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "$lib/components/ui/select";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { Textarea } from "$lib/components/ui/textarea";
    import { InputGroup, InputGroupAddon, InputGroupInput } from "$lib/components/ui/input-group";
    import { Tabs, TabsList, TabsTab } from "$lib/components/ui/tabs";
    import { Frame, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "$lib/components/ui/frame";
    import { segmentedControlItemVariants, segmentedControlRootClassName } from "$lib/components/ui/tabs/segmented-control";
    import { cn } from "$lib/utils";
    import Box from "@lucide/svelte/icons/box";
    import ChevronLeft from "@lucide/svelte/icons/chevron-left";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import KeyRound from "@lucide/svelte/icons/key-round";
    import Search from "@lucide/svelte/icons/search";
    import { orpc, queryClient } from "$lib/orpc";
    import { createMutation, createQuery } from "@tanstack/svelte-query";
    import { useQueryStates } from "nuqs-svelte";
    import { watch } from "runed";
    import { onDestroy, untrack } from "svelte";

    let { open = $bindable(false), projectId }: { open?: boolean; projectId: string } =
        $props();

    const fields = useQueryStates(resourceFormParsers, { shallow: true, scroll: false });

    const fromGit = $derived(fields.source.current === "git");

    const fromTemplate = $derived(fields.source.current === "template");

    const templatesQuery = createQuery(() => orpc.resources.listTemplates.queryOptions({ enabled: fromTemplate }));

    const template = $derived(templatesQuery.data?.find((t) => t.appId === fields.template.current));

    const picking = $derived(fromTemplate && !template);

    let templateVersion = $state("");

    let variables = $state<Record<string, string>>({});

    const version = $derived(template?.versions.find((v) => v.version === templateVersion) ?? template?.versions[0]);

    let search = $state("");

    let tag = $state("all");

    let showDescription = $state(false);

    const tags = $derived([...new Set(templatesQuery.data?.flatMap((t) => t.tags))].toSorted());

    const visibleTemplates = $derived(
        templatesQuery.data?.filter((t) => {
            const query = search.trim().toLowerCase();

            return (
                (tag === "all" || t.tags.includes(tag)) &&
                (!query || [t.name, t.description, ...t.tags].some((text) => text.toLowerCase().includes(query)))
            );
        }) ?? [],
    );

    const pathname = untrack(() => page.url.pathname);

    let active = true;

    onDestroy(() => { active = false; });

    let connectionId = $state("");

    let repositoryUrl = $state("");

    let branch = $state("");

    let path = $state(".");

    watch(
        () => open,
        (isOpen, wasOpen) => {
            if (isOpen && wasOpen !== true) resetPrivateFields();
        },
    );

    function resetPrivateFields() {
        connectionId = "";
        repositoryUrl = "";
        branch = "";
        path = ".";
        templateVersion = "";
        variables = {};
        search = "";
        tag = "all";
        showDescription = false;
        createMutationState.reset();
    }

    const createMutationState = createMutation(() =>
        orpc.resources.createResource.mutationOptions({
            onSuccess: async (_updated, input) => {
                await queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.queryKey({
                        input: { projectId: input.projectId },
                    }),
                });
                void queryClient.invalidateQueries({ queryKey: orpc.projects.key() });

                if (active && projectId === input.projectId && page.url.pathname === pathname) open = false;
            },
        }),
    );

    const errorMessage = $derived(
        createMutationState.error
            ? createMutationState.error.message || "Unable to create resource."
            : "",
    );

    const canSubmit = $derived(Boolean(fields.resourceName.current.trim()) && !createMutationState.isPending && (!fromGit || Boolean(connectionId && repositoryUrl && branch.trim() && path.trim())) && (!fromTemplate || Boolean(version && version.required.every((key) => variables[key]?.trim()))));

    async function createResource(event: SubmitEvent) {
        event.preventDefault();

        if (!canSubmit) return;
        createMutationState.mutate({
            projectId,
            name: fields.resourceName.current.trim(),
            description: fields.resourceDescription.current.trim() || undefined,
            type: "compose",
            git: fromGit ? { connectionId, repositoryUrl, branch: branch.trim(), path: path.trim() } : undefined,
            template: fromTemplate && template && version ? { appId: template.appId, version: version.version, variables: Object.fromEntries(version.required.map((key) => [key, variables[key]?.trim() ?? ""])) } : undefined,
        });
    }

    let previousTemplateName = "";

    function selectTemplate(next: { appId: string; name: string } | null) {
        fields.template.current = next?.appId ?? "";
        templateVersion = "";

        if (!next) return;

        if (!fields.resourceName.current.trim() || fields.resourceName.current === previousTemplateName) fields.resourceName.current = next.name;

        previousTemplateName = next.name;
    }
</script>

<Dialog bind:open>
    <DialogContent class={cn(picking ? "sm:max-w-3xl" : "sm:max-w-xl")}>
        <DialogHeader>
            {#if fromTemplate && template}
                <div class="flex items-start gap-3 pe-8">
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Back to templates"
                        disabled={createMutationState.isPending}
                        onclick={() => selectTemplate(null)}
                    >
                        <ChevronLeft aria-hidden="true" />
                    </Button>
                    {#if template.logo}
                        <img src={template.logo} alt="" class="size-8 shrink-0 object-contain" />
                    {/if}
                    <div class="min-w-0 space-y-1">
                        <DialogTitle>{template.name}</DialogTitle>
                        <DialogDescription>{template.description}</DialogDescription>
                    </div>
                </div>
            {:else}
                <DialogTitle>{fromTemplate ? "New from template" : "New Compose"}</DialogTitle>
                <DialogDescription>
                    {fromTemplate ? "Choose a template to start from." : "Create a compose resource in this project."}
                </DialogDescription>
            {/if}
        </DialogHeader>
        <DialogPanel>
            {#if errorMessage}
                <Alert variant="error" class="mb-4">
                    <AlertDescription>{errorMessage}</AlertDescription>
                </Alert>
            {/if}
            {#if picking}
                {@render templatePicker()}
            {:else}
                <form
                    id="create-resource-form"
                    method="POST"
                    onsubmit={createResource}
                    class="space-y-4"
                    aria-busy={createMutationState.isPending}
                >
                    {#if template && template.versions.length > 1}
                        {#if template.versions.length <= 4}
                            <fieldset class="space-y-2" disabled={createMutationState.isPending}>
                                <legend class="mb-2 text-sm font-medium">Version</legend>
                                <div class={cn(segmentedControlRootClassName, "w-full")}>
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
                                                checked={v.version === version?.version}
                                                onchange={() => (templateVersion = v.version)}
                                            />
                                            {v.version}
                                        </label>
                                    {/each}
                                </div>
                            </fieldset>
                        {:else}
                            <Field>
                                <Label for="template-version" required>Version</Label>
                                <Select
                                    value={version?.version}
                                    items={template.versions.map((v) => ({ value: v.version, label: v.version }))}
                                    disabled={createMutationState.isPending}
                                    onValueChange={(value) => (templateVersion = value ?? "")}
                                >
                                    <SelectTrigger id="template-version">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {#each template.versions as v (v.version)}<SelectItem value={v.version} label={v.version} />{/each}
                                    </SelectContent>
                                </Select>
                            </Field>
                        {/if}
                    {/if}
                    <Field>
                        <div class="flex w-full items-center justify-between gap-2">
                            <Label for="resource-name" required>Name</Label>
                            {#if fromTemplate && !showDescription && !fields.resourceDescription.current}
                                <button
                                    type="button"
                                    class="rounded-sm text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                                    onclick={() => (showDescription = true)}
                                >
                                    + Add description
                                </button>
                            {/if}
                        </div>
                        <Input
                            id="resource-name"
                            bind:value={fields.resourceName.current}
                            placeholder="My service"
                            required
                            maxlength={100}
                            disabled={createMutationState.isPending}
                        />
                    </Field>
                    {#if !fromTemplate || showDescription || fields.resourceDescription.current}
                        <Field>
                            <Label for="resource-description">Description</Label>
                            <Textarea
                                id="resource-description"
                                bind:value={fields.resourceDescription.current}
                                placeholder="What is this resource for?"
                                maxlength={500}
                                rows={2}
                                disabled={createMutationState.isPending}
                            />
                        </Field>
                    {/if}
                    {#if version}
                        {#each version.required as key (key)}
                            <Field>
                                <Label for="template-variable-{key}" required class="font-mono">{key}</Label>
                                <Input
                                    id="template-variable-{key}"
                                    bind:value={() => variables[key] ?? "", (value) => (variables[key] = value)}
                                    required
                                    autocomplete="off"
                                    maxlength={4096}
                                    disabled={createMutationState.isPending}
                                />
                            </Field>
                        {/each}
                        {@render templateContents(version)}
                    {/if}
                    {#if !fromTemplate}
                        <label class="flex items-center gap-2 text-sm">
                            <input
                                type="checkbox"
                                bind:checked={() => fromGit, (checked) => { fields.source.current = checked ? "git" : "blank"; }}
                                disabled={createMutationState.isPending}
                            />
                            Import from Git
                        </label>
                    {/if}
                    {#if fromGit}
                        <GitSourceFields bind:connectionId bind:repositoryUrl bind:branch bind:path disabled={createMutationState.isPending} />
                    {/if}
                </form>
            {/if}
        </DialogPanel>
        {#if !picking}
            <DialogFooter>
                <Button
                    variant="outline"
                    disabled={createMutationState.isPending}
                    onclick={() => {
                        open = false;
                    }}
                >
                    Cancel
                </Button>
                <Button
                    type="submit"
                    form="create-resource-form"
                    loading={createMutationState.isPending}
                    disabled={!canSubmit}
                >
                    Create Resource
                </Button>
            </DialogFooter>
        {/if}
    </DialogContent>
</Dialog>

{#snippet templatePicker()}
    {#if templatesQuery.isError}
        <Alert variant="error"><AlertDescription>Unable to load templates: {templatesQuery.error.message}</AlertDescription></Alert>
    {:else if templatesQuery.isPending}
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {#each { length: 6 }, index (index)}
                <Skeleton loading loading-label="Loading templates"><div class="h-32 rounded-xl border border-border"></div></Skeleton>
            {/each}
        </div>
    {:else}
        <div class="space-y-4">
            <InputGroup>
                <InputGroupInput type="search" placeholder="Search templates" aria-label="Search templates" bind:value={search} />
                <InputGroupAddon align="inline-start"><Search aria-hidden="true" /></InputGroupAddon>
            </InputGroup>
            {#if tags.length > 1}
                <Tabs value={tag} onValueChange={(value) => (tag = String(value ?? "all"))}>
                    <TabsList variant="underline" class="w-full justify-start overflow-x-auto">
                        <TabsTab value="all" class="grow-0">All</TabsTab>
                        {#each tags as value (value)}<TabsTab {value} class="grow-0 capitalize">{value}</TabsTab>{/each}
                    </TabsList>
                </Tabs>
            {/if}
            {#if visibleTemplates.length === 0}
                <p class="py-8 text-center text-sm text-muted-foreground">
                    {templatesQuery.data.length === 0 ? "No templates available." : "No templates match your search."}
                </p>
            {:else}
                <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {#each visibleTemplates as item (item.appId)}
                        {@const services = item.versions[0]?.services.length ?? 0}
                        <button
                            type="button"
                            class="flex cursor-pointer flex-col gap-3 rounded-xl border border-border bg-background p-4 text-start transition-colors outline-none hover:border-ring/60 hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                            onclick={() => selectTemplate(item)}
                        >
                            <span class="flex items-center gap-3">
                                <span class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted">
                                    {#if item.logo}
                                        <img src={item.logo} alt="" class="size-5 object-contain" />
                                    {:else}
                                        <Box class="size-5 text-muted-foreground" aria-hidden="true" />
                                    {/if}
                                </span>
                                <span class="min-w-0">
                                    <span class="block truncate text-sm font-medium">{item.name}</span>
                                    <span class="block text-xs text-muted-foreground">
                                        {services} {services === 1 ? "service" : "services"}
                                    </span>
                                </span>
                            </span>
                            <span class="line-clamp-2 flex-1 text-xs text-muted-foreground">{item.description}</span>
                            {#if item.tags.length > 0}
                                <span class="flex flex-wrap gap-1">
                                    {#each item.tags as value (value)}<Badge variant="outline">{value}</Badge>{/each}
                                </span>
                            {/if}
                        </button>
                    {/each}
                </div>
            {/if}
        </div>
    {/if}
{/snippet}

{#snippet templateContents(v: {
    services: { name: string; image: string | null; volumes: { source: string | null; target: string }[] }[];
    secrets: string[];
})}
    <Frame>
        <FrameHeader class="flex-row items-baseline gap-2 px-4 py-3">
            <FrameTitle><h3>Services</h3></FrameTitle>
            <span class="text-xs tabular-nums text-muted-foreground">{v.services.length}</span>
        </FrameHeader>
        <FramePanel class="divide-y divide-border p-0">
            {#each v.services as service (service.name)}
                <div class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 px-3 py-2.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
                    <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <Box class="size-4" aria-hidden="true" />
                    </span>
                    <div class="min-w-0">
                        <p class="truncate text-sm font-medium leading-5">{service.name}</p>
                        {#if service.image}
                            <p class="truncate font-mono text-xs leading-5 text-muted-foreground" title={service.image}>{service.image}</p>
                        {/if}
                    </div>
                    {#if service.volumes.length > 0}
                        <ul class="col-start-2 flex min-w-0 flex-wrap gap-1 sm:col-start-auto sm:max-w-48 sm:flex-col sm:items-end" aria-label="Volumes">
                            {#each service.volumes as volume (volume.target)}
                                <li class="max-w-full">
                                    <Badge
                                        variant="outline"
                                        class="max-w-full font-mono font-normal text-muted-foreground"
                                        title={volume.source ? `${volume.source}:${volume.target}` : volume.target}
                                    >
                                        <HardDrive aria-hidden="true" />
                                        <span class="truncate">{volume.target}</span>
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
                <p class="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <KeyRound class="size-3.5" aria-hidden="true" />
                    {v.secrets.length} {v.secrets.length === 1 ? "secret" : "secrets"} generated, editable later in Variables
                </p>
                <ul class="flex flex-wrap gap-1">
                    {#each v.secrets as secret (secret)}
                        <li><Badge variant="secondary" class="font-mono font-normal">{secret}</Badge></li>
                    {/each}
                </ul>
            </FrameFooter>
        {/if}
    </Frame>
{/snippet}
