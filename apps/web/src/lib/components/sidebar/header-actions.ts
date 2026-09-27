import { createContext, onMount, type Snippet } from "svelte";

export const [getHeaderActions, setHeaderActions] = createContext<{ content?: Snippet }>();

export function useHeaderActions(content: Snippet) {
    const actions = getHeaderActions();

    onMount(() => {
        actions.content = content;

        return () => {
            if (actions.content === content) actions.content = undefined;
        };
    });
}
