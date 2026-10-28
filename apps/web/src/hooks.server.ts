import { building, dev } from "$app/environment";
import type { Handle, RequestEvent } from "@sveltejs/kit";
import { sequence } from "@sveltejs/kit/hooks";
import { getRequestEvent } from "$app/server";
import { svelteKitHandler, sveltekitCookies } from "better-auth/svelte-kit";

import "./lib/server/orpc";
import "./lib/server/rpc-socket";
import { identifyUser } from "evlog/better-auth";
import { createFsDrain } from "evlog/fs";
import { createEvlogHooks } from "evlog/sveltekit";

import { CLIENT_IP_HEADER } from "@stoat/auth";
import { env } from "./env.server";
import { getAuth, setAuthCookiePlugin } from "./services";
import { startMonitoringWorker } from "./lib/server/worker";

/** WebSocket calls (rpc-socket.ts) read sessions outside any request, with no response to set cookies on. */
function currentRequestEvent(): RequestEvent | undefined {
    try {
        return getRequestEvent();
    } catch {
        return undefined;
    }
}

// Forwards cookies set by server-side auth calls (session cache refreshes, active organization
// changes) to the browser.
setAuthCookiePlugin(
    // SAFETY: better-auth skips cookie forwarding when the getter returns no event.
    sveltekitCookies(currentRequestEvent as () => RequestEvent),
);

// Server modules also execute during `vite build` (SSR analysis). The worker
// must only run in a live server, never at build time. With USE_INTERNAL_WORKER=false,
// a separate worker container (src/worker.ts) runs it instead.
if (!building && env.USE_INTERNAL_WORKER !== false) {
    startMonitoringWorker();
}

const { handle: evlogHandle, handleError } = createEvlogHooks({
    drain: dev ? createFsDrain() : undefined,
});

// Better Auth rate-limits by this header. It always comes from the connection (or the proxy
// header set by ADDRESS_HEADER), so a client cannot pick its own address.
const clientIpHandle: Handle = ({ event, resolve }) => {
    event.request.headers.set(CLIENT_IP_HEADER, event.getClientAddress());

    return resolve(event);
};

const authHandle: Handle = async ({ event, resolve }) => {
    const authInstance = getAuth();

    return svelteKitHandler({
        event,
        resolve,
        auth: authInstance,
        building,
    });
};

// Runs after authHandle, so Better Auth's own routes never get here. Every load, action and
// oRPC call (including in-process SSR calls) reads this one session instead of its own.
const sessionHandle: Handle = async ({ event, resolve }) => {
    const session = await getAuth().api.getSession({ headers: event.request.headers });

    event.locals.session = session;

    if (session) identifyUser(event.locals.log, session, { maskEmail: true });

    return resolve(event);
};

export const handle = sequence(clientIpHandle, evlogHandle, authHandle, sessionHandle);

export { handleError };
