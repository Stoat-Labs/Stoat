<script lang="ts">
    import { browser } from "$app/environment";
    import { createQueryClient, queryClient } from "$lib/api/orpc";
    import { QueryClientProvider } from "@tanstack/svelte-query";
    import { SvelteQueryDevtools } from "@tanstack/svelte-query-devtools";
    import { NuqsAdapter } from "nuqs-svelte/adapters/svelte-kit";
    import { ToastProvider } from "$lib/components/ui/toast";
    import "../app.css";

    const { children } = $props();

    // Server renders share this module, so each one gets its own cache.
    const client = browser ? queryClient : createQueryClient();
</script>

<QueryClientProvider {client}>
    <NuqsAdapter>
        <ToastProvider>
            {@render children()}
        </ToastProvider>
    </NuqsAdapter>
    <SvelteQueryDevtools />
</QueryClientProvider>
