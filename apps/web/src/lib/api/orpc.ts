import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/websocket";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { AppRouterClient } from "@stoat/api/routers/index";
import { QueryCache, QueryClient } from "@tanstack/svelte-query";

export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            // Layout (AppShell), sidebars, and detail pages all subscribe to
            // the same listProjects/listResources keys. Without a staleTime
            // every mount refetches, so navigating between resources
            // re-fires identical requests. 15s keeps nav snappy without
            // serving stale data for long; mutations still invalidate.
            staleTime: 15_000,
            gcTime: 5 * 60_000,
            refetchOnWindowFocus: false,
            retry: 1,
        },
    },
    queryCache: new QueryCache({
        onError: (error) => {
            console.error(`Error: ${error.message}`);
        },
    }),
});

// Every browser call, streams included, shares one WebSocket. It reconnects on its own, and
// sign-in/sign-out do a full page load, so the socket's session cookie is never stale.
export const link = new RPCLink({
    connect() {
        if (typeof window === "undefined") {
            throw new Error("This link is not allowed on the server side.");
        }

        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

        return new WebSocket(`${protocol}//${window.location.host}/rpc`);
    },
    reconnect: { enabled: true },
});

declare global {
    // Set by $lib/orpc.server.ts (imported from hooks.server.ts) so SSR can
    // call the API in-process instead of over HTTP.
    // eslint-disable-next-line no-var
    var $client: AppRouterClient | undefined;
}

const browserClient = createORPCClient<AppRouterClient>(link);

/**
 * The SSR client is a singleton created when orpc.server.ts first loads. Vite
 * dev HMR replaces that instance when @stoat/api changes, but this module is
 * NOT re-evaluated (it only type-imports the router), so a captured reference
 * goes stale and new procedures read as `undefined` (e.g.
 * `orpc.resources.getResource` -> "Cannot read properties of undefined
 * (reading 'queryOptions')"). Always resolve the current instance.
 */
function getEffectiveClient(): AppRouterClient {
    if (typeof window === "undefined") {
        const serverClient = globalThis.$client;

        if (serverClient) return serverClient;
    }

    return browserClient;
}

type OrpcUtils = ReturnType<typeof createTanstackQueryUtils<AppRouterClient>>;

let cachedClient: AppRouterClient | undefined;

let cachedUtils: OrpcUtils | undefined;

function getUtils(): OrpcUtils {
    const effective = getEffectiveClient();

    if (!cachedUtils || cachedClient !== effective) {
        cachedClient = effective;
        cachedUtils = createTanstackQueryUtils(effective);
    }

    return cachedUtils;
}

/**
 * Lazily proxied so SSR always uses the current server client, even after HMR
 * swaps it. Kept for API compatibility; prefer `orpc` for queries/mutations.
 */
export const client: AppRouterClient = new Proxy(browserClient, {
    get(_target, prop) {
        // SAFETY: Forward the proxy's property unchanged to the identically typed client.
        return getEffectiveClient()[prop as keyof AppRouterClient];
    },
});

/**
 * Lazily proxied TanStack Query utils. Rebuilt automatically when the
 * underlying client instance changes, so new procedures are picked up without
 * a dev-server restart.
 */
export const orpc: OrpcUtils = new Proxy(createTanstackQueryUtils(browserClient), {
    get(_target, prop) {
        // SAFETY: Both the proxy target and current query utilities implement OrpcUtils.
        return getUtils()[prop as keyof OrpcUtils];
    },
    has(_target, prop) {
        return Reflect.has(getUtils(), prop);
    },
});

// The template catalog ships with the server build, so it only changes on a deploy.
queryClient.setQueryDefaults(orpc.resources.listTemplates.key(), { staleTime: Infinity });
