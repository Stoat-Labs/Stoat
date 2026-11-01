<script lang="ts">
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import CodeEditor from "$lib/components/shared/code-editor.svelte";
    import ReferenceInput from "$lib/components/variables/reference-input.svelte";
    import VariableReferencePicker from "$lib/components/variables/variable-reference-picker.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import { Input } from "$lib/components/ui/input";
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import Braces from "@lucide/svelte/icons/braces";
    import Check from "@lucide/svelte/icons/check";
    import ChevronRight from "@lucide/svelte/icons/chevron-right";
    import EllipsisVertical from "@lucide/svelte/icons/ellipsis-vertical";
    import FileCode from "@lucide/svelte/icons/file-code";
    import Link2 from "@lucide/svelte/icons/link-2";
    import Plus from "@lucide/svelte/icons/plus";
    import X from "@lucide/svelte/icons/x";
    import type { EditorView } from "@codemirror/view";
    import { createQuery } from "@tanstack/svelte-query";
    import {
        parseAsBoolean,
        parseAsString,
        useQueryState,
    } from "nuqs-svelte";
    import { VARIABLE_REFERENCE } from "@stoat/workflows/variable-reference";
    import * as v from "valibot";
    import {
        VariableHeader,
        VariableRow,
        VariableValue,
    } from "$lib/components/ui/variable";
    import {
        parseEnvLines,
        removeEnvVariable,
        setEnvVariable,
    } from "@stoat/workflows/env-lines";
    import {
        applyComposeSections,
        composeEnvironment,
        composeEnvironmentSections,
        setComposeEnvironment,
        splitRawEnvironment,
        composeServiceNames,
    } from "./compose-environment";
    import type { CanvasResource } from "../graph";

    let { resource }: { resource: CanvasResource } = $props();

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

    // Until the project loads, nothing is editable, so an internal resource never flashes its edit controls.
    const readOnly = $derived(
        !projectQuery.isSuccess ||
            projectQuery.data.isInternal === true,
    );

    const referencesQuery = createQuery(() =>
        orpc.resources.listVariableReferences.queryOptions({
            input,
            enabled: projectQuery.isSuccess && !readOnly,
        }),
    );

    const references = $derived(referencesQuery.data ?? []);

    const envSchema = v.fallback(
        v.object({ env: v.fallback(v.string(), "") }),
        { env: "" },
    );

    const env = $derived(
        v.parse(envSchema, resourceQuery.data?.settings).env,
    );

    const variables = $derived(parseEnvLines(env));

    const names = $derived(
        new Map(references.map((target) => [target.id, target.name])),
    );

    // Railway's variable search, kept in the URL like the open tab.
    const search = useQueryState(
        "variableSearch",
        parseAsString.withOptions({ shallow: true, scroll: false }),
    );

    const needle = $derived(
        search.current?.trim().toLowerCase() ?? "",
    );

    // Compose `environment` wins over Variables at deploy, so these are edited in the Compose file itself.
    const composeVariables = $derived(
        composeEnvironment(resourceQuery.data?.draftSpec ?? ""),
    );

    const composeServices = $derived(
        new Set(composeVariables.map((variable) => variable.service)),
    );

    type Row = {
        id: string;
        key: string;
        value: string;
        service?: string;
    };

    const rows = $derived<Row[]>([
        ...variables.map(({ key, value }) => ({
            id: key,
            key,
            value,
        })),
        ...composeVariables.map(({ service, key, value }) => ({
            id: `compose:${service}/${key}`,
            key,
            value,
            service,
        })),
    ]);

    const shown = $derived(
        rows.filter((row) => row.key.toLowerCase().includes(needle)),
    );

    const systemQuery = createQuery(() =>
        orpc.resources.listSystemVariables.queryOptions({ input }),
    );

    // A same-named user variable overrides a built-in; it already has its own row above.
    const systemVariables = $derived(
        (systemQuery.data ?? []).filter(
            (variable) =>
                !variables.some((own) => own.key === variable.key) &&
                variable.key.toLowerCase().includes(needle),
        ),
    );

    // Railway's collapsed "variables added by Railway", open state kept in the URL.
    const systemOpen = useQueryState(
        "systemVariables",
        parseAsBoolean
            .withDefault(false)
            .withOptions({ shallow: true, scroll: false }),
    );

    let revealed = $state(new Set<string>());

    function toggle(key: string) {
        const next = new Set(revealed);

        if (!next.delete(key)) next.add(key);

        revealed = next;
    }

    function hasReference(value: string) {
        return [...value.matchAll(VARIABLE_REFERENCE)].length > 0;
    }

    // `{{ <id>.KEY }}` reads better as `{{ Name.KEY }}`.
    function display(value: string) {
        return value.replace(
            VARIABLE_REFERENCE,
            (reference, id: string, key: string) =>
                names.has(id)
                    ? `{{ ${names.get(id)}.${key} }}`
                    : reference,
        );
    }

    let saving = $state(false);

    let error = $state("");

    // Railway's inline add row, shown in place of the header.
    let adding = $state(false);

    let newKey = $state("");

    let newValue = $state("");

    const validKey = $derived(
        /^[A-Za-z_][\w.-]*$/u.test(newKey.trim()),
    );

    const keyTaken = $derived(
        variables.some((variable) => variable.key === newKey.trim()),
    );

    // The row whose value is being edited in place.
    let editing = $state<Row>();

    let editValue = $state("");

    let removing = $state<Row>();

    let rawOpen = $state(false);

    let rawText = $state("");

    // What the raw editor opened with, so an untouched file can't be saved.
    let rawInitial = $state("");

    // The Variables and Compose draft the raw editor opened from. Saving applies the edits to these
    // and refuses if either changed meanwhile, instead of overwriting a teammate's change.
    let rawEnv = "";

    let rawCompose: string | null = null;

    // The Variables .env, then each Compose service's `environment` under a `# [service]` header.
    function openRaw() {
        error = "";

        try {
            rawEnv = env;
            rawCompose = resourceQuery.data?.draftSpec ?? null;

            const sections = composeEnvironmentSections(
                rawCompose ?? "",
            );

            rawInitial = sections
                ? `${env.trimEnd()}${env.trim() ? "\n\n" : ""}${sections}\n`
                : env;
        } catch (cause) {
            error =
                cause instanceof Error
                    ? cause.message
                    : "Could not open the raw editor.";

            return;
        }

        rawText = rawInitial;
        rawOpen = true;
    }

    async function saveRaw() {
        let split;

        try {
            split = splitRawEnvironment(
                rawText,
                composeServiceNames(rawCompose ?? ""),
            );
        } catch (cause) {
            error =
                cause instanceof Error
                    ? cause.message
                    : "Could not read the raw editor.";

            return;
        }

        const { env: nextEnv, sections } = split;

        const spec = applyComposeSections(rawCompose ?? "", sections);

        // Check both before writing either, so a conflict saves nothing.
        const current = await queryClient.fetchQuery(
            orpc.resources.getResource.queryOptions({
                input,
                staleTime: 0,
            }),
        );

        if (
            v.parse(envSchema, current.settings).env !== rawEnv ||
            current.draftSpec !== rawCompose
        ) {
            error =
                "These Variables changed while you were editing. Copy your edits, reopen the editor and try again.";

            return;
        }

        const envSaved =
            nextEnv.trimEnd() === rawEnv.trimEnd() ||
            (await save(() => nextEnv, rawEnv));

        if (envSaved && (await saveCompose(() => spec, rawCompose)))
            rawOpen = false;
    }

    let rawView = $state<EditorView>();

    // Every write starts from the freshest saved file, so it only changes what was edited.
    // With `expected`, the server refuses the write if the saved Variables are no longer that.
    async function save(
        next: (current: string) => string,
        expected?: string,
    ) {
        saving = true;
        error = "";

        try {
            const current = await queryClient.fetchQuery(
                orpc.resources.getResource.queryOptions({
                    input,
                    staleTime: 0,
                }),
            );

            const updated = await client.resources.updateVariables({
                ...input,
                env: next(v.parse(envSchema, current.settings).env),
                expectedEnv: expected,
            });

            queryClient.setQueryData(
                orpc.resources.getResource.queryKey({ input }),
                updated,
            );
            void queryClient.invalidateQueries({
                queryKey: orpc.resources.listResources.key(),
            });
            void queryClient.invalidateQueries({
                queryKey: orpc.resources.getProjectGraph.key(),
            });

            return true;
        } catch (cause) {
            error =
                cause instanceof Error
                    ? cause.message
                    : "Could not save.";

            return false;
        } finally {
            saving = false;
        }
    }

    // Compose edits rewrite their entries in the freshest saved Compose file, or in `base`, the
    // draft an edit started from: then the server refuses the write if the draft is no longer that.
    async function saveCompose(
        next: (current: string) => string,
        base?: string | null,
    ) {
        saving = true;
        error = "";

        try {
            const current = await queryClient.fetchQuery(
                orpc.resources.getResource.queryOptions({
                    input,
                    staleTime: 0,
                }),
            );

            const expectedSpec =
                base === undefined ? current.draftSpec : base;

            const from = expectedSpec ?? "";
            const spec = next(from);

            if (spec === from) return true;

            const updated = await client.resources.updateComposeSpec({
                ...input,
                spec,
                expectedSpec,
                expectedSource:
                    current.gitConnectionId && current.gitSource
                        ? {
                              connectionId: current.gitConnectionId,
                              ...current.gitSource,
                          }
                        : null,
            });

            queryClient.setQueryData(
                orpc.resources.getResource.queryKey({ input }),
                updated,
            );
            void queryClient.invalidateQueries({
                queryKey: orpc.resources.getProjectGraph.key(),
            });

            return true;
        } catch (cause) {
            error =
                cause instanceof Error
                    ? cause.message
                    : "Unable to update the Compose file.";

            return false;
        } finally {
            saving = false;
        }
    }

    function saveRow(row: Row, value?: string) {
        if (row.service !== undefined)
            return saveCompose((current) =>
                setComposeEnvironment(
                    current,
                    row.service ?? "",
                    row.key,
                    value,
                ),
            );

        return save((current) =>
            value === undefined
                ? removeEnvVariable(current, row.key)
                : setEnvVariable(current, row.key, value),
        );
    }

    function startAdding() {
        newKey = "";
        newValue = "";
        error = "";
        editing = undefined;
        adding = true;
    }

    async function add() {
        if (!validKey || keyTaken || saving) return;

        const key = newKey.trim();

        const value = newValue;

        if (
            await save((current) =>
                setEnvVariable(current, key, value),
            )
        )
            adding = false;
    }

    function startEditing(row: Row) {
        error = "";
        adding = false;
        editValue = row.value;
        editing = row;
    }

    async function update() {
        if (!editing || saving) return;

        if (await saveRow(editing, editValue)) editing = undefined;
    }

    function escapeTo(close: () => void) {
        return (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.stopPropagation();
                close();
            }
        };
    }
</script>

<div class="space-y-4">
    {#if adding}
        <form
            class="flex items-center gap-2"
            onsubmit={(event) => {
                event.preventDefault();
                void add();
            }}
        >
            <Input
                bind:value={newKey}
                onkeydown={escapeTo(() => (adding = false))}
                placeholder="VARIABLE_NAME"
                aria-label="Variable name"
                class="min-w-0 flex-1 font-mono"
                autocomplete="off"
                spellcheck={false}
                autofocus
            />
            <ReferenceInput
                bind:value={newValue}
                label="Variable value"
                targets={references}
                projectId={resource.projectId}
                loading={referencesQuery.isPending}
                onsubmit={() => void add()}
                onescape={() => (adding = false)}
            />
            <Button
                type="submit"
                loading={saving}
                disabled={saving || !validKey || keyTaken}
            >
                <Check class="size-4" aria-hidden="true" />
                Add
            </Button>
            <Button
                type="button"
                variant="outline"
                onclick={() => (adding = false)}
            >
                Cancel
            </Button>
        </form>
        {#if newKey.trim() && !validKey}
            <p class="text-xs text-destructive-foreground">
                Start with a letter or underscore; use letters,
                digits, _, . or -.
            </p>
        {:else if keyTaken}
            <p class="text-xs text-destructive-foreground">
                {newKey.trim()} already exists. Edit it from its row instead.
            </p>
        {/if}
    {:else}
        <VariableHeader
            count={rows.length}
            search={search.current}
            onsearch={(value) => void search.set(value)}
        >
            <Button size="sm" variant="ghost" onclick={openRaw}>
                <Braces class="size-4" aria-hidden="true" />
                Raw Editor
            </Button>
            {#if !readOnly}
                <Button
                    size="sm"
                    variant="outline"
                    onclick={startAdding}
                >
                    <Plus class="size-4" aria-hidden="true" />
                    New Variable
                </Button>
            {/if}
        </VariableHeader>
    {/if}

    <div class="border-t"></div>

    {#if error && !removing && !rawOpen}
        <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
        </Alert>
    {/if}

    {#if resourceQuery.isPending}
        <Skeleton loading count={3} label="Loading variables">
            <div
                class="flex h-10 items-center gap-4 px-4 font-mono text-sm"
            >
                <span>VARIABLE_NAME</span>
                <span>*******</span>
            </div>
        </Skeleton>
    {:else if resourceQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load variables: {resourceQuery.error
                    .message}
            </AlertDescription>
        </Alert>
    {:else if !rows.length}
        <p
            class="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground"
        >
            No variables yet. Add one, or paste a whole .env in the
            raw editor.
        </p>
    {:else}
        <ul>
            {#each shown as variable (variable.id)}
                {@const isReference = hasReference(variable.value)}
                {@const visible = revealed.has(variable.id)}
                <VariableRow
                    name={variable.key}
                    description={composeServices.size > 1
                        ? variable.service
                        : undefined}
                >
                    {#snippet icon()}
                        {#if variable.service !== undefined}
                            <span
                                class="flex"
                                title="Set in Compose ({variable.service})"
                            >
                                <FileCode
                                    class="size-4 text-muted-foreground"
                                    aria-label="Set in Compose"
                                />
                            </span>
                        {:else if isReference}
                            <Link2
                                class="size-4 text-muted-foreground"
                                aria-label="References another resource"
                            />
                        {:else}
                            <Braces
                                class="size-4 text-muted-foreground"
                                aria-hidden="true"
                            />
                        {/if}
                    {/snippet}
                    {#if editing?.id === variable.id}
                        <form
                            class="col-span-2 flex items-center gap-1 py-1"
                            onsubmit={(event) => {
                                event.preventDefault();
                                void update();
                            }}
                        >
                            <ReferenceInput
                                bind:value={editValue}
                                label="{variable.key} value"
                                targets={references}
                                projectId={resource.projectId}
                                loading={referencesQuery.isPending}
                                autofocus
                                onsubmit={() => void update()}
                                onescape={() => (editing = undefined)}
                            />
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                type="button"
                                aria-label="Cancel editing {variable.key}"
                                onclick={() => (editing = undefined)}
                            >
                                <X
                                    class="size-4"
                                    aria-hidden="true"
                                />
                            </Button>
                            <Button
                                size="icon-sm"
                                variant="ghost"
                                type="submit"
                                aria-label="Save {variable.key}"
                                loading={saving}
                                disabled={saving}
                            >
                                <Check
                                    class="size-4"
                                    aria-hidden="true"
                                />
                            </Button>
                        </form>
                    {:else}
                        <VariableValue
                            name={variable.key}
                            value={display(variable.value)}
                            {visible}
                            ontoggle={() => toggle(variable.id)}
                            oncopy={() =>
                                void navigator.clipboard.writeText(
                                    variable.value,
                                )}
                        />
                    {/if}
                    {#snippet menu()}
                        {#if editing?.id !== variable.id}
                            <Menu>
                                <MenuTrigger
                                    class="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                                    aria-label="{variable.key} actions"
                                >
                                    <EllipsisVertical
                                        class="size-4"
                                        aria-hidden="true"
                                    />
                                </MenuTrigger>
                                <MenuPopup
                                    align="end"
                                    class="min-w-40"
                                >
                                    {#if readOnly}
                                        <MenuItem
                                            onclick={() =>
                                                void navigator.clipboard.writeText(
                                                    variable.value,
                                                )}
                                        >
                                            Copy value
                                        </MenuItem>
                                    {:else}
                                        <MenuItem
                                            onclick={() =>
                                                startEditing(
                                                    variable,
                                                )}
                                        >
                                            Edit
                                        </MenuItem>
                                        <MenuItem
                                            variant="destructive"
                                            onclick={() => {
                                                error = "";
                                                removing = variable;
                                            }}
                                        >
                                            Delete
                                        </MenuItem>
                                    {/if}
                                </MenuPopup>
                            </Menu>
                        {/if}
                    {/snippet}
                </VariableRow>
            {:else}
                <li class="px-4 py-3 text-sm text-muted-foreground">
                    No variables match "{search.current}".
                </li>
            {/each}
        </ul>
    {/if}

    {#if systemVariables.length}
        <div class="border-t"></div>
        <!-- Railway's "variables added by Railway": built-ins, read-only, collapsed by default. -->
        <section>
            <button
                type="button"
                class="flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground aria-expanded:text-foreground"
                aria-expanded={systemOpen.current}
                onclick={() =>
                    void systemOpen.set(!systemOpen.current)}
            >
                <ChevronRight
                    class={[
                        "size-4 transition-transform",
                        systemOpen.current && "rotate-90",
                    ]}
                    aria-hidden="true"
                />
                {systemVariables.length}
                {systemVariables.length === 1
                    ? "variable"
                    : "variables"}
                added by Stoat
            </button>

            {#if systemOpen.current}
                <p class="mt-4 px-4 text-sm text-muted-foreground">
                    Stoat provides these to every resource. Use them
                    as
                    <code class="font-mono">${"{NAME}"}</code>
                    in Compose and Variables, or reference them from other
                    resources. Set a variable with the same name to override
                    one.
                </p>
                <ul class="mt-3">
                    {#each systemVariables as variable (variable.key)}
                        <VariableRow
                            name={variable.key}
                            description={variable.description}
                        >
                            <VariableValue
                                name={variable.key}
                                value={variable.value}
                                visible={revealed.has(variable.key)}
                                ontoggle={() => toggle(variable.key)}
                                oncopy={() =>
                                    void navigator.clipboard.writeText(
                                        variable.value,
                                    )}
                            />
                            {#snippet menu()}
                                <!-- Railway's "Reference": copies the interpolation to paste into Compose or Variables. -->
                                <Button
                                    size="xs"
                                    variant="outline"
                                    class="text-muted-foreground"
                                    onclick={() =>
                                        void navigator.clipboard.writeText(
                                            `\${${variable.key}}`,
                                        )}
                                >
                                    Reference
                                </Button>
                            {/snippet}
                        </VariableRow>
                    {/each}
                </ul>
            {/if}
        </section>
    {/if}
</div>

{#if removing}
    {@const row = removing}
    <ConfirmDialog
        bind:open={
            () => removing !== undefined,
            (open) => {
                if (!open) removing = undefined;
            }
        }
        title="Delete {row.key}?"
        description={row.service === undefined
            ? "It is removed from the draft. Deploy the resource to apply it."
            : "It is removed from the Compose file's draft. Deploy the resource to apply it."}
        confirmLabel="Delete"
        pending={saving}
        {error}
        onconfirm={async () => {
            if (await saveRow(row)) removing = undefined;
        }}
    />
{/if}

<!-- Railway's raw editor: the whole file at once, references included. -->
<Dialog bind:open={rawOpen}>
    <DialogContent class="max-w-3xl">
        <DialogHeader>
            <DialogTitle>Raw Editor</DialogTitle>
            <DialogDescription>
                Edit the .env file directly; Compose variables sit
                under their
                {"# [service]"} header. Type {"{{"} to reference another
                resource's variable.
            </DialogDescription>
        </DialogHeader>
        <div
            class="raw-env mx-6 h-[60dvh] overflow-hidden rounded-md border"
        >
            <CodeEditor
                bind:value={rawText}
                bind:view={rawView}
                language="env"
                label="Environment variables (.env)"
                {readOnly}
            />
            {#if !readOnly}
                <VariableReferencePicker
                    view={rawView}
                    targets={references}
                    projectId={resource.projectId}
                    loading={referencesQuery.isPending}
                    error={referencesQuery.error?.message}
                />
            {/if}
        </div>
        {#if error}
            <Alert variant="error" class="mx-6">
                <AlertDescription>{error}</AlertDescription>
            </Alert>
        {/if}
        <DialogFooter>
            <Button
                variant="outline"
                onclick={() => (rawOpen = false)}
            >
                Cancel
            </Button>
            {#if !readOnly}
                <Button
                    loading={saving}
                    disabled={saving || rawText === rawInitial}
                    onclick={saveRaw}
                >
                    Update Variables
                </Button>
            {/if}
        </DialogFooter>
    </DialogContent>
</Dialog>

<style>
    .raw-env > :global(div),
    .raw-env :global(.cm-editor) {
        height: 100%;
    }

    .raw-env :global(.cm-scroller) {
        height: 100%;
        max-height: none;
    }
</style>
