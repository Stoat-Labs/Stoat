<script lang="ts">
    import { Compartment, StateEffect } from "@codemirror/state";
    import type { EditorView } from "@codemirror/view";
    import ArrowLeft from "@lucide/svelte/icons/arrow-left";
    import ChevronRight from "@lucide/svelte/icons/chevron-right";
    import Search from "@lucide/svelte/icons/search";
    import {
        Command,
        CommandCollection,
        CommandEmpty,
        CommandGroup,
        CommandGroupLabel,
        CommandInput,
        CommandItem,
        CommandList,
    } from "$lib/components/ui/command";
    import {
        Popover,
        PopoverPopup,
    } from "$lib/components/ui/popover";
    import { envReferences } from "./env-references";
    import {
        projectName,
        referenceGroups,
        type ReferenceGroup,
        type ReferenceOption,
        type ReferencePage,
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

    let page = $state<ReferencePage>({ level: "projects" });

    let input = $state<HTMLInputElement | null>(null);

    // Document range the picked reference replaces: the typed `{{`, or the selection.
    let range = { from: 0, to: 0 };

    const groups = $derived(
        referenceGroups(targets, page, projectId),
    );

    const names = $derived(
        new Map(targets.map((target) => [target.id, target.name])),
    );

    const placeholder = $derived(
        page.level === "projects"
            ? "Search projects"
            : page.level === "resources"
              ? `Search resources in ${projectName(targets, page.projectId)}`
              : `Search variables in ${page.target.name}`,
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

    /** Opens on this project's resources; the picked reference replaces `from`..`to`. */
    export function openAt(from: number, to: number) {
        range = { from, to };
        go({ level: "resources", projectId });
        open = true;
    }

    function go(next: ReferencePage) {
        page = next;
        query = "";
    }

    function back() {
        if (page.level === "variables")
            go({ level: "resources", projectId: page.projectId });
        else go({ level: "projects" });
    }

    function choose(option: ReferenceOption) {
        if (option.next) return go(option.next);

        if (!view || !option.key || !option.target) return;

        const insert = `{{ ${option.target.id}.${option.key} }}`;

        view.dispatch({
            changes: { ...range, insert },
            selection: { anchor: range.from + insert.length },
            userEvent: "input.complete",
        });
        open = false;
    }

    const extension = new Compartment();

    let attached: EditorView | undefined;

    // Names change as targets load, so the extension lives in a compartment.
    $effect(() => {
        if (!view) return;
        const content = envReferences(names, openAt);

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

    // Each page mounts a new input, which takes the focus back.
    $effect(() => {
        input?.focus();
    });
</script>

<Popover
    bind:open
    onOpenChangeComplete={(isOpen) => {
        if (!isOpen) view?.focus();
    }}
>
    <PopoverPopup
        customAnchor={anchor}
        align="start"
        finalFocus={false}
        class="w-80 **:data-[slot=popover-viewport]:p-0"
    >
        {#key page}
            <Command
                items={groups}
                bind:value={query}
                itemToStringValue={(option: ReferenceOption) =>
                    option.label}
                class="max-h-80"
            >
                <CommandInput
                    bind:ref={input}
                    size="sm"
                    {placeholder}
                    aria-label={placeholder}
                    onkeydown={(event) => {
                        if (
                            event.isComposing ||
                            page.level === "projects"
                        )
                            return;

                        // Backspace or ← on an empty search goes up a level; Escape always closes.
                        if (
                            query === "" &&
                            (event.key === "Backspace" ||
                                event.key === "ArrowLeft")
                        ) {
                            event.preventDefault();
                            event.stopPropagation();
                            back();
                        }
                    }}
                >
                    {#snippet start()}
                        {#if page.level !== "projects"}
                            <button
                                type="button"
                                aria-label="Back"
                                class="-ms-0.5 flex rounded-sm p-0.5 hover:bg-accent"
                                onclick={back}
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
                <CommandEmpty>
                    {#if loading}
                        Loading resources...
                    {:else if error}
                        Unable to load resources: {error}
                    {:else if query}
                        Nothing matches "{query}".
                    {:else if page.level === "resources"}
                        No other resources in this project.
                    {:else if page.level === "variables"}
                        {page.target.name} has no variables.
                    {:else}
                        No other resources on this cluster yet.
                    {/if}
                </CommandEmpty>
                <CommandList>
                    <CommandCollection>
                        {#snippet children(group: ReferenceGroup)}
                            <CommandGroup items={group.items}>
                                <CommandGroupLabel>
                                    {group.label}
                                </CommandGroupLabel>
                                <CommandCollection>
                                    {#snippet children(
                                        option: ReferenceOption,
                                    )}
                                        <CommandItem
                                            value={option}
                                            class="gap-2"
                                            onclick={() =>
                                                choose(option)}
                                        >
                                            <span
                                                class={[
                                                    "min-w-0 flex-1 truncate",
                                                    option.key &&
                                                        "font-mono",
                                                ]}
                                            >
                                                {option.label}
                                            </span>
                                            {#if option.hint}
                                                <span
                                                    class="shrink-0 text-xs text-muted-foreground"
                                                >
                                                    {option.hint}
                                                </span>
                                            {/if}
                                            {#if option.next}
                                                <ChevronRight
                                                    class="size-4 shrink-0 text-muted-foreground"
                                                    aria-hidden="true"
                                                />
                                            {/if}
                                        </CommandItem>
                                    {/snippet}
                                </CommandCollection>
                            </CommandGroup>
                        {/snippet}
                    </CommandCollection>
                </CommandList>
            </Command>
        {/key}
    </PopoverPopup>
</Popover>
