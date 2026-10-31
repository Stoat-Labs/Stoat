<script lang="ts">
    import { browser } from "$app/environment";
    import { createQueryClient, queryClient } from "$lib/api/orpc";
    import { QueryClientProvider } from "@tanstack/svelte-query";
    import { SvelteQueryDevtools } from "@tanstack/svelte-query-devtools";
    import { NuqsAdapter } from "nuqs-svelte/adapters/svelte-kit";
    import { SkulletProvider } from "skullet/svelte";
    import { ToastProvider } from "$lib/components/ui/toast";
    import "../app.css";

    const { children } = $props();

    // Server renders share this module, so each one gets its own cache.
    const client = browser ? queryClient : createQueryClient();

    // Chrome rings a clicked button as soon as an unmodified key like Escape is pressed, so such a key drops click focus instead.
    const navigationKeys = new Set([
        "Tab",
        "Enter",
        " ",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
    ]);

    let pointer = false;

    let clicked: EventTarget | null = null;
</script>

<svelte:window
    onpointerdown={() => (pointer = true)}
    onpointerup={() => (pointer = false)}
    onfocusin={(event) => (clicked = pointer ? event.target : null)}
    onkeydown={(event) => {
        if (
            event.altKey ||
            event.ctrlKey ||
            event.metaKey ||
            navigationKeys.has(event.key) ||
            !(clicked instanceof HTMLElement) ||
            clicked !== document.activeElement ||
            clicked.matches(
                "input, textarea, select, [contenteditable]",
            )
        )
            return;

        clicked.blur();
    }}
/>

<QueryClientProvider {client}>
    <NuqsAdapter>
        <ToastProvider>
            <!-- Sends skullet's server-render measuring script once a page instead of per skeleton. -->
            <SkulletProvider>
                {@render children()}
            </SkulletProvider>
        </ToastProvider>
    </NuqsAdapter>
    <SvelteQueryDevtools />
</QueryClientProvider>
