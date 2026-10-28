# @stoat/trees

Svelte 5 bindings for [`@pierre/trees`](https://github.com/pierrecomputer/pierre/tree/main/packages/trees): a virtualized file tree that renders in a shadow root.

```jsonc
// package.json of the consuming app
"dependencies": {
    "@stoat/trees": "workspace:*"
}
```

## Basic usage

```svelte
<script lang="ts">
    import { FileTree, createFileTree } from "@stoat/trees";

    // Created once, cleaned up with this component.
    const model = createFileTree({
        paths: ["README.md", "src/index.ts", "src/lib/utils.ts"],
        initialExpansion: "open",
    });
</script>

<FileTree {model} style="height: 320px" />
```

The tree needs a height. Any extra attributes (`class`, `style`, `id`, `aria-*`, event handlers) go to the `<file-tree-container>` host element.

## Header and context menu

Both are snippets. The context menu snippet gets the row's `item` and a `ctx` with `close()`, `anchorRect` and `anchorElement`.

```svelte
<FileTree {model} style="height: 320px">
    {#snippet header()}
        <strong>Project files</strong>
    {/snippet}

    {#snippet contextMenu(item, ctx)}
        <menu>
            <button
                onclick={() => {
                    navigator.clipboard.writeText(item.path);
                    ctx.close();
                }}
            >
                Copy path
            </button>
            <button
                onclick={() => {
                    ctx.close({ restoreFocus: false });
                    model.startRenaming(item.path);
                }}
            >
                Rename
            </button>
        </menu>
    {/snippet}
</FileTree>
```

Passing `contextMenu` turns the menu on (right-click by default). To change the trigger, set it on the model:

```ts
createFileTree({ paths, composition: { contextMenu: { triggerMode: "both" } } });
```

## Reactive state

`createFileTree` returns the plain `@pierre/trees` model, so every method is there: `add`, `remove`, `move`, `resetPaths`, `setGitStatus`, `focusPath`, `scrollToPath` and so on. To read model state reactively, use these helpers:

```svelte
<script lang="ts">
    import {
        FileTree,
        createFileTree,
        useFileTreeSearch,
        useFileTreeSelection,
        useFileTreeSelector,
    } from "@stoat/trees";

    const model = createFileTree({ paths, search: true });

    const selection = useFileTreeSelection(model);
    const focused = useFileTreeSelector(model, (m) => m.getFocusedPath());
    const search = useFileTreeSearch(model);
</script>

<input
    value={search.value}
    oninput={(e) => search.setValue(e.currentTarget.value)}
    placeholder="Filter files"
/>
<span>{search.matchingPaths.length} matches</span>

<FileTree {model} style="height: 320px" />

<p>Focused: {focused.current ?? "none"}</p>
<p>Selected: {selection.current.join(", ")}</p>
```

Only the template parts and effects that read a value re-run when the tree changes, so there's no equality callback like React's `isEqual`.

## Updating paths

Options only apply when the model is created. Later changes go through model methods:

```svelte
<script lang="ts">
    let { paths }: { paths: string[] } = $props();

    // svelte-ignore state_referenced_locally
    const model = createFileTree({ paths });

    $effect(() => model.resetPaths(paths));
</script>
```

## SSR (SvelteKit)

Render the tree on the server so it paints before JS loads. On the client, the model hydrates that HTML in place instead of re-rendering it.

```ts
// +page.server.ts
import { preloadFileTree } from "@pierre/trees/ssr";

export const load = () => {
    const options = {
        id: "docs-tree",
        paths: ["README.md", "src/index.ts"],
        initialVisibleRowCount: 8,
    };

    return { options, preloadedData: preloadFileTree(options) };
};
```

```svelte
<!-- +page.svelte -->
<script lang="ts">
    import { FileTree, createFileTree } from "@stoat/trees";

    let { data } = $props();

    // svelte-ignore state_referenced_locally
    const model = createFileTree(data.options);
</script>

<FileTree {model} preloadedData={data.preloadedData} style="height: 320px" />
```

Use the same options (including `id`) for `preloadFileTree` and `createFileTree`, or hydration won't match. An app that imports `@pierre/trees/ssr` directly needs `@pierre/trees` in its own dependencies.

## API

| Export                           | What it does                                                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `<FileTree>`                     | Props: `model`, `header?`, `contextMenu?`, `preloadedData?`, plus any host attributes.                                       |
| `createFileTree(options)`        | `new FileTree(options)`, plus `cleanUp()` when the component is destroyed. Call it during component init.                    |
| `useFileTreeSelector(model, fn)` | `{ current }`, a reactive `fn(model)`.                                                                                       |
| `useFileTreeSelection(model)`    | `{ current }`, the selected paths.                                                                                           |
| `useFileTreeSearch(model)`       | Reactive `isOpen`, `value` and `matchingPaths`, plus `open`, `close`, `setValue`, `focusNextMatch` and `focusPreviousMatch`. |

The full option list (icons, git status, density, drag and drop, renaming, row decorations, theming) is in the [`@pierre/trees` README](https://github.com/pierrecomputer/pierre/tree/main/packages/trees).

## Development

```bash
pnpm --dir packages/trees test         # tests in tests/trees
pnpm --dir packages/trees check-types  # svelte-check, including the tests
```
