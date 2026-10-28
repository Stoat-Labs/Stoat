export { default as FileTree, type FileTreePreloadedData } from "./FileTree.svelte";

export {
    createFileTree,
    useFileTreeSearch,
    useFileTreeSelection,
    useFileTreeSelector,
    type FileTreeSearchState,
} from "./state.svelte";

export type { FileTreeDirectoryHandle, FileTreeItemHandle } from "@pierre/trees";
