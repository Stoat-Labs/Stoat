import { FileTree, type FileTreeOptions } from "@pierre/trees";
import { onMount } from "svelte";
import { createSubscriber } from "svelte/reactivity";

// Must be called during component init; the model is cleaned up when that
// component is destroyed. Later option changes go through model methods.
export function createFileTree(options: FileTreeOptions): FileTree {
    const model = new FileTree(options);
    onMount(() => () => model.cleanUp());

    return model;
}

// Reading `.current` inside an effect or template re-runs it on model changes.
export function useFileTreeSelector<T>(model: FileTree, selector: (model: FileTree) => T) {
    const track = createSubscriber((update) => model.subscribe(update));

    return {
        get current() {
            track();

            return selector(model);
        },
    };
}

export function useFileTreeSelection(model: FileTree) {
    return useFileTreeSelector(model, (m) => m.getSelectedPaths());
}

export interface FileTreeSearchState {
    readonly isOpen: boolean;
    readonly matchingPaths: readonly string[];
    readonly value: string;
    close: () => void;
    focusNextMatch: () => void;
    focusPreviousMatch: () => void;
    open: (initialValue?: string) => void;
    setValue: (value: string | null) => void;
}

export function useFileTreeSearch(model: FileTree): FileTreeSearchState {
    const track = createSubscriber((update) => model.subscribe(update));

    return {
        get isOpen() {
            track();

            return model.isSearchOpen();
        },
        get matchingPaths() {
            track();

            return model.getSearchMatchingPaths();
        },
        get value() {
            track();

            return model.getSearchValue();
        },
        close: () => model.closeSearch(),
        focusNextMatch: () => model.focusNextSearchMatch(),
        focusPreviousMatch: () => model.focusPreviousSearchMatch(),
        open: (initialValue) => model.openSearch(initialValue),
        setValue: (value) => model.setSearch(value),
    };
}
