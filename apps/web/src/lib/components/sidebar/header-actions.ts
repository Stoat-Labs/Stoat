import { createContext, onMount, type Snippet } from "svelte";

export const [getHeaderActions, setHeaderActions] = createContext<{ content?: Snippet }>();

export function useHeaderActions(content: Snippet, enabled = () => true) {
    const actions = getHeaderActions();

    onMount(() => {
        if (!enabled()) return;

        actions.content = content;

        return () => {
            if (actions.content === content) actions.content = undefined;
        };
    });
}
