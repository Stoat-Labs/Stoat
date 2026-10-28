import { RangeSetBuilder, StateField, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, WidgetType } from "@codemirror/view";
import { referenceResourceId, VARIABLE_REFERENCE } from "@stoat/workflows/variable-reference";

/** Shows a whole `{{ <id>.KEY }}` as one `Name.KEY` chip. */
class ReferenceWidget extends WidgetType {
    constructor(readonly label: string) {
        super();
    }

    override eq(other: ReferenceWidget) {
        return other.label === this.label;
    }

    toDOM() {
        const chip = document.createElement("span");
        chip.className = "cm-reference-name";
        chip.textContent = this.label;

        return chip;
    }
}

const unknownReference = Decoration.mark({
    class: "cm-reference-unknown",
    attributes: { title: "Unknown resource. Type {{ and pick one instead." },
});

/** Where each whole reference sits, and its resource's name when the id is a known resource. */
export function referenceSpans(text: string, names: Map<string, string>) {
    return Array.from(text.matchAll(VARIABLE_REFERENCE), (match) => {
        const [reference, id = "", key = ""] = match;

        return {
            from: match.index,
            to: match.index + reference.length,
            name: names.get(referenceResourceId(id) ?? ""),
            key,
        };
    });
}

/** A `{{` (not `{{{`) ending `before`, as the range a picked reference replaces. */
export function typedTrigger(before: string, cursor: number): [number, number] | undefined {
    if (before.endsWith("{{") && !before.endsWith("{{{")) return [cursor - 2, cursor];
}

function referenceDecorations(state: EditorState, names: Map<string, string>) {
    const ranges = new RangeSetBuilder<Decoration>();

    for (const { from, to, name, key } of referenceSpans(state.doc.toString(), names))
        ranges.add(
            from,
            to,
            name
                ? Decoration.replace({ widget: new ReferenceWidget(`${name}.${key}`) })
                : unknownReference,
        );

    return ranges.finish();
}

/**
 * Editor side of `{{ <resourceId>.KEY }}`: each renders as a `Name.KEY` chip, and typing `{{`
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
            // The cursor skips a whole reference, and Backspace deletes it in one go.
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
