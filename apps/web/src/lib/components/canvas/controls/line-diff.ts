export type DiffLine =
    | { kind: "same" | "add" | "remove"; text: string }
    /** Unchanged lines left out between hunks, like `git diff`. */
    | { kind: "skip"; count: number };

function lines(text: string) {
    return text === "" ? [] : text.replace(/\n$/u, "").split("\n");
}

/** Line diff by longest common subsequence; Compose and `.env` files are small enough for it. */
function fullDiff(before: string[], after: string[]) {
    const rows = before.length;
    const columns = after.length;

    // common[i][j]: the longest common run of before[i..] and after[j..].
    const common = Array.from({ length: rows + 1 }, () =>
        Array.from({ length: columns + 1 }, () => 0),
    );

    for (let i = rows - 1; i >= 0; i--)
        for (let j = columns - 1; j >= 0; j--)
            common[i]![j] =
                before[i] === after[j]
                    ? common[i + 1]![j + 1]! + 1
                    : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);

    const diff: { kind: "same" | "add" | "remove"; text: string }[] = [];
    let i = 0;
    let j = 0;

    while (i < rows || j < columns) {
        if (i < rows && j < columns && before[i] === after[j]) {
            diff.push({ kind: "same", text: before[i]! });
            i++;
            j++;
        } else if (i < rows && (j === columns || common[i + 1]![j]! >= common[i]![j + 1]!)) {
            // Removals before additions, as git prints them.
            diff.push({ kind: "remove", text: before[i]! });
            i++;
        } else {
            diff.push({ kind: "add", text: after[j]! });
            j++;
        }
    }

    return diff;
}

/** The changed lines of `before` → `after`, each with `context` unchanged lines around it. */
export function lineDiff(before: string, after: string, context = 3): DiffLine[] {
    const diff = fullDiff(lines(before), lines(after));

    const near = diff.map((_, index) =>
        diff
            .slice(Math.max(0, index - context), index + context + 1)
            .some((line) => line.kind !== "same"),
    );

    const result: DiffLine[] = [];

    for (const [index, line] of diff.entries()) {
        if (near[index]) result.push(line);
        else {
            const last = result.at(-1);

            if (last?.kind === "skip") last.count++;
            else result.push({ kind: "skip", count: 1 });
        }
    }

    return result;
}
