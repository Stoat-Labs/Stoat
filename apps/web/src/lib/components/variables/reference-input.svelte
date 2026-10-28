<script lang="ts">
    import { minimalSetup } from "codemirror";
    import { EditorState, Prec } from "@codemirror/state";
    import {
        EditorView,
        keymap,
        placeholder,
    } from "@codemirror/view";
    import Braces from "@lucide/svelte/icons/braces";
    import { onMount } from "svelte";
    import VariableReferencePicker from "./variable-reference-picker.svelte";
    import type { ReferenceTarget } from "./reference-options";

    let {
        value = $bindable(""),
        label,
        targets,
        projectId,
        loading = false,
        autofocus = false,
        onsubmit,
        onescape,
    }: {
        value?: string;
        label: string;
        targets: ReferenceTarget[];
        projectId: string;
        loading?: boolean;
        autofocus?: boolean;
        onsubmit: () => void;
        onescape: () => void;
    } = $props();

    let container: HTMLDivElement;

    let view = $state<EditorView>();

    onMount(() => {
        const editor = new EditorView({
            parent: container,
            state: EditorState.create({
                doc: value,
                extensions: [
                    minimalSetup,
                    // A variable value is one line: pasted newlines are dropped, anything else with one is refused.
                    EditorView.clipboardInputFilter.of((text) =>
                        text.replaceAll(/\r?\n/gu, ""),
                    ),
                    EditorState.transactionFilter.of((transaction) =>
                        transaction.newDoc.lines > 1
                            ? []
                            : transaction,
                    ),
                    Prec.highest(
                        keymap.of([
                            {
                                key: "Enter",
                                run: () => (onsubmit(), true),
                            },
                            {
                                key: "Escape",
                                run: () => (onescape(), true),
                            },
                        ]),
                    ),
                    placeholder(
                        "VALUE, or type {{ to reference a variable",
                    ),
                    EditorView.contentAttributes.of({
                        "aria-label": label,
                        spellcheck: "false",
                    }),
                    EditorView.updateListener.of((update) => {
                        if (update.docChanged)
                            value = update.state.doc.toString();
                    }),
                    EditorView.theme({
                        "&": { fontSize: "inherit" },
                        "&.cm-focused": { outline: "none" },
                        ".cm-scroller": {
                            fontFamily: "var(--font-mono)",
                            lineHeight: "1.875rem",
                            overflowY: "hidden",
                        },
                        ".cm-content": { padding: "0" },
                        ".cm-line": { padding: "0 11px" },
                    }),
                ],
            }),
        });

        view = editor;

        if (autofocus) editor.focus();

        return () => editor.destroy();
    });

    let picker: VariableReferencePicker;

    // The picked reference replaces the selection, or lands at the cursor.
    function openPicker() {
        if (!view) return;
        const { from, to } = view.state.selection.main;

        picker.openAt(from, to);
    }
</script>

<div
    class="relative flex min-w-0 flex-1 items-center rounded-lg border border-input bg-background text-base shadow-xs/5 ring-ring/24 transition-shadow has-[.cm-focused]:border-ring has-[.cm-focused]:ring-[3px] sm:text-sm dark:bg-input/32"
>
    <div bind:this={container} class="min-w-0 flex-1"></div>
    <button
        type="button"
        class="mr-1 flex size-6 shrink-0 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        aria-label="Reference another resource's variable"
        onclick={openPicker}
    >
        <Braces class="size-3.5" aria-hidden="true" />
    </button>
</div>
<VariableReferencePicker
    bind:this={picker}
    {view}
    {targets}
    {projectId}
    {loading}
/>
