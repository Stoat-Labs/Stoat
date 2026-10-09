import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType } from "@codemirror/view";
import { referenceResourceId, VARIABLE_REFERENCE } from "@stoat/workflows/variable-reference";

/** Shows a resource's name where its id sits in `{{ <id>.KEY }}`. */
class ResourceNameWidget extends WidgetType {
    constructor(readonly name: string) {
        super();
    }

    override eq(other: ResourceNameWidget) {
        return other.name === this.name;
    }

    toDOM() {
        const chip = document.createElement("span");
        chip.className = "cm-reference-name";
        chip.textContent = this.name;

        return chip;
    }
}

const unknownReference = Decoration.mark({
    class: "cm-reference-unknown",
    attributes: { title: "Unknown resource. Type {{ and pick one instead." },
});

/** Where each reference's resource id sits, and its name when the id is a known resource. */
export function referenceSpans(text: string, names: Map<string, string>) {
    return Array.from(text.matchAll(VARIABLE_REFERENCE), (match) => {
        const [reference, id = ""] = match;
        const from = match.index + reference.indexOf(id);

        return { from, to: from + id.length, name: names.get(referenceResourceId(id) ?? "") };
    });
}

/** A `{{` (not `{{{`) ending `before`, as the range a picked reference replaces. */
export function typedTrigger(before: string, cursor: number): [number, number] | undefined {
    if (before.endsWith("{{") && !before.endsWith("{{{")) return [cursor - 2, cursor];
}

function referenceDecorations(state: EditorState, names: Map<string, string>) {
    const ranges = new RangeSetBuilder<Decoration>();

    for (const { from, to, name } of referenceSpans(state.doc.toString(), names))
        ranges.add(
            from,
            to,
            name ? Decoration.replace({ widget: new ResourceNameWidget(name) }) : unknownReference,
        );

    return ranges.finish();
}

/**
 * Editor side of `{{ <resourceId>.KEY }}`: ids render as resource names, and typing `{{`
 * (or Ctrl-Space) calls `onTrigger` with the range a picked reference should replace.
 */
export function envReferences(
    names: Map<string, string>,
    onTrigger: (from: number, to: number) => void,
): Extension {
    const decorations = StateField.define({
        create: (state) => referenceDecorations(state, names),
        update: (current, transaction) =>
            transaction.docChanged ? referenceDecorations(transaction.state, names) : current,
        provide: (field) => [
            EditorView.decorations.from(field),
            // The cursor skips over a whole id instead of stepping through its characters.
            EditorView.atomicRanges.of((view) => view.state.field(field)),
        ],
    });

    return [
        decorations,
        EditorView.updateListener.of((update) => {
            if (!update.transactions.some((transaction) => transaction.isUserEvent("input.type")))
                return;
            const { head, empty } = update.state.selection.main;

            const trigger =
                empty && typedTrigger(update.state.sliceDoc(Math.max(0, head - 3), head), head);

            if (trigger) onTrigger(...trigger);
        }),
        keymap.of([
            {
                key: "Ctrl-Space",
                run: (view) => {
                    const { head } = view.state.selection.main;
                    onTrigger(head, head);

                    return true;
                },
            },
        ]),
        EditorView.theme({
            ".cm-reference-name": {
                padding: "0 4px",
                borderRadius: "4px",
                backgroundColor: "color-mix(in srgb, var(--primary) 18%, transparent)",
                color: "var(--foreground)",
            },
            ".cm-reference-unknown": {
                textDecoration: "underline wavy var(--destructive)",
            },
        }),
    ];
}
