import { expect, it } from "vite-plus/test";
import { lineDiff } from "../../apps/web/src/lib/components/canvas/controls/line-diff";

it("marks changed lines and keeps unchanged ones in order", () => {
    expect(lineDiff("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([
        { kind: "same", text: "a" },
        { kind: "remove", text: "b" },
        { kind: "add", text: "B" },
        { kind: "same", text: "c" },
        { kind: "add", text: "d" },
    ]);
});

it("shows a first deploy as all additions", () => {
    expect(lineDiff("", "services:\n  web:\n")).toEqual([
        { kind: "add", text: "services:" },
        { kind: "add", text: "  web:" },
    ]);
});

it("folds unchanged stretches outside the context, like git diff", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
    const after = before.replace("line 10", "line ten");

    const diff = lineDiff(before, after, 2);

    expect(diff[0]).toEqual({ kind: "skip", count: 8 });
    expect(diff.filter((line) => line.kind !== "skip")).toEqual([
        { kind: "same", text: "line 8" },
        { kind: "same", text: "line 9" },
        { kind: "remove", text: "line 10" },
        { kind: "add", text: "line ten" },
        { kind: "same", text: "line 11" },
        { kind: "same", text: "line 12" },
    ]);
    expect(diff.at(-1)).toEqual({ kind: "skip", count: 7 });
});

it("has nothing to show for identical files", () => {
    expect(lineDiff("a\nb", "a\nb").every((line) => line.kind === "skip")).toBe(true);
});

it("compares large files without building a full comparison table", () => {
    const before = Array.from({ length: 10_000 }, (_, index) => `line ${index}`).join("\n");

    expect(lineDiff(before, before)).toEqual([{ kind: "skip", count: 10_000 }]);

    // Every line changed: too large to compare line by line, so the block is replaced.
    const after = before.replaceAll("line", "row");
    const diff = lineDiff(before, after, 0);

    expect(diff.filter((line) => line.kind === "remove")).toHaveLength(10_000);
    expect(diff.filter((line) => line.kind === "add")).toHaveLength(10_000);
});
