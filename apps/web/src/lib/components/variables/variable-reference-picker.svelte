<script lang="ts">
    import { Compartment, StateEffect } from "@codemirror/state";
    import type { EditorView } from "@codemirror/view";
    import Search from "@lucide/svelte/icons/search";
    import {
        Autocomplete,
        AutocompleteCollection,
        AutocompleteEmpty,
        AutocompleteGroup,
        AutocompleteGroupLabel,
        AutocompleteInput,
        AutocompleteItem,
        AutocompleteList,
        AutocompletePopup,
    } from "$lib/components/ui/autocomplete";
    import { tick } from "svelte";
    import { envReferences } from "./env-references";
    import {
        referenceGroups,
        type ReferenceGroup,
        type ReferenceOption,
        type ReferenceTarget,
    } from "./reference-options";

    let {
        view,
        targets,
        projectId,
        loading = false,
        error,
    }: {
        view: EditorView | undefined;
        targets: ReferenceTarget[];
        projectId: string;
        loading?: boolean;
        // Why the resource list could not be loaded, if it failed.
        error?: string;
    } = $props();

    let open = $state(false);

    let query = $state("");

    let selected = $state<ReferenceTarget>();

    // Document range the picked reference replaces: the typed `{{`, or the cursor.
    let range = { from: 0, to: 0 };

    const groups = $derived(
        referenceGroups(targets, projectId, selected),
    );

    const names = $derived(
        new Map(targets.map((target) => [target.id, target.name])),
    );

    const anchor = {
        getBoundingClientRect: () => {
            const caret = view?.coordsAtPos(range.from);

            return caret
                ? new DOMRect(
                      caret.left,
                      caret.top,
                      0,
                      caret.bottom - caret.top,
                  )
                : new DOMRect();
        },
    };

    const extension = new Compartment();

    let attached: EditorView | undefined;

    function trigger(from: number, to: number) {
        range = { from, to };
        selected = undefined;
        query = "";
        open = true;
    }

    // Names change as targets load, so the extension lives in a compartment.
    $effect(() => {
        if (!view) return;
        const content = envReferences(names, trigger);

        if (attached === view)
            view.dispatch({
                effects: extension.reconfigure(content),
            });
        else {
            attached = view;
            view.dispatch({
                effects: StateEffect.appendConfig.of(
                    extension.of(content),
                ),
            });
        }
    });

    async function pick(option: ReferenceOption) {
        if (!option.key) {
            selected = option.target;
            // Any item press closes the popup, so reopen it on the keys with a fresh search.
            await tick();
            open = true;
            query = "";

            return;
        }

        if (!view) return;
        const insert = `{{ ${option.target.id}.${option.key} }}`;

        view.dispatch({
            changes: { ...range, insert },
            selection: { anchor: range.from + insert.length },
            userEvent: "input.complete",
        });
        open = false;
    }
</script>

<Autocomplete
    bind:open
    bind:value={query}
    items={groups}
    itemToStringValue={(option: ReferenceOption) => option.search}
    autoHighlight
    onOpenChangeComplete={(isOpen) => {
        // Skipped when the popup reopened for the keys step.
        if (!isOpen && !open) view?.focus();
    }}
>
    <AutocompletePopup {anchor} finalFocus={false} class="w-80">
        <div class="border-b p-1.5">
            <AutocompleteInput
                size="sm"
                placeholder={selected
                    ? `Variables in ${selected.name}`
                    : "Search resources"}
                aria-label={selected
                    ? `Search variables in ${selected.name}`
                    : "Search resources"}
                onkeydown={(event) => {
                    // Backspace on an empty search goes back to the resource list.
                    if (event.key === "Backspace" && query === "")
                        selected = undefined;
                }}
            >
                {#snippet startAddon()}
                    <Search />
                {/snippet}
            </AutocompleteInput>
        </div>
        <AutocompleteEmpty>
            {#if loading}
                Loading resources...
            {:else if error}
                Unable to load resources: {error}
            {:else if targets.length === 0}
                No other resources on this cluster yet.
            {:else if selected}
                No matching variables.
            {:else}
                No matching resources.
            {/if}
        </AutocompleteEmpty>
        <AutocompleteList>
            <AutocompleteCollection>
                {#snippet children(group: ReferenceGroup)}
                    <AutocompleteGroup items={group.items}>
                        <AutocompleteGroupLabel>
                            {group.label}
                        </AutocompleteGroupLabel>
                        <AutocompleteCollection>
                            {#snippet children(
                                option: ReferenceOption,
                            )}
                                <AutocompleteItem
                                    value={option}
                                    class={option.key
                                        ? "font-mono"
                                        : ""}
                                    onclick={() => pick(option)}
                                >
                                    {option.key ?? option.target.name}
                                </AutocompleteItem>
                            {/snippet}
                        </AutocompleteCollection>
                    </AutocompleteGroup>
                {/snippet}
            </AutocompleteCollection>
        </AutocompleteList>
    </AutocompletePopup>
</Autocomplete>
