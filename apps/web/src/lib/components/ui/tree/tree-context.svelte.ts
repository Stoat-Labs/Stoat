import { Context } from "runed";
import type { ReactiveItemInstance, ReactiveTree } from "./use-tree.svelte";

export interface TreeContextValue<T = unknown> {
    currentItem?: ReactiveItemInstance<T>;
    indent: number;
    tree?: ReactiveTree<T>;
}

// The provider's item type is erased here; useTreeContext<T> restores it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const treeContext = new Context<TreeContextValue<any> | undefined>("tree:context");

export function useTreeContext<T = unknown>(): TreeContextValue<T> {
    const context = treeContext.get();

    if (!context) {
        throw new Error("useTree must be used within a Tree");
    }

    return context;
}
