import { ORPCError } from "@orpc/client";
import { toastManager } from "$lib/components/ui/toast";

/** Reconnect transport failures and explicitly retryable API errors; completed streams stay stopped. */
export function subscribeToStream<T>(
    connect: (signal: AbortSignal) => Promise<AsyncIterable<T>>,
    onEvent: (event: T) => void,
    onError: (error: Error, reconnecting: boolean) => void,
    isComplete: () => boolean = () => false,
    retryCodes: readonly string[] = [],
) {
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;

    async function run() {
        if (controller.signal.aborted) return;
        let delivering = false;

        try {
            const stream = await connect(controller.signal);

            for await (const event of stream) {
                if (controller.signal.aborted) return;
                delivering = true;
                onEvent(event);
                delivering = false;
            }

            if (!controller.signal.aborted && !isComplete())
                throw new Error("Live stream ended unexpectedly.");
        } catch (error) {
            if (controller.signal.aborted) return;

            // A dropped socket rejects with a plain AbortError, so it reconnects too.
            const reconnecting =
                !delivering && (!(error instanceof ORPCError) || retryCodes.includes(error.code));

            onError(
                error instanceof Error ? error : new Error("Stream connection failed."),
                reconnecting,
            );

            if (reconnecting && !controller.signal.aborted)
                retry = setTimeout(() => void run(), 2000);
        }
    }

    void run();

    return () => {
        controller.abort();
        clearTimeout(retry);
    };
}

// Every live stream shares the one RPC WebSocket, so a dropped socket warns once, not per stream.
let id: string | undefined;

/** The shared live-stream warning toast: kept up to date while it retries, closed once it reconnects. */
export function streamErrorToast() {
    let pending: ReturnType<typeof setTimeout> | undefined;

    let latest: Error | undefined;

    function open(error: Error, reconnecting: boolean) {
        const toast = {
            type: "warning",
            title: reconnecting ? "Live updates lost. Reconnecting..." : "Live updates stopped",
            description: reconnecting
                ? error.message
                : `${error.message} Reload the page to reconnect.`,
            timeout: 0,
        };

        if (id) toastManager.update(id, toast);
        else id = toastManager.add({ ...toast, onClose: () => (id = undefined) });
    }

    function clear() {
        clearTimeout(pending);
        pending = undefined;

        if (id) toastManager.close(id);
    }

    return {
        show(error: Error, reconnecting: boolean) {
            latest = error;

            // A dropped socket usually comes back on the first retry, so only a lasting outage warns.
            if (reconnecting && !id) {
                pending ??= setTimeout(() => {
                    pending = undefined;

                    if (latest) open(latest, true);
                }, 5000);

                return;
            }

            clearTimeout(pending);
            pending = undefined;
            open(error, reconnecting);
        },
        clear,
        /** Wraps a stream's connect so the toast closes once it is back, not on its next event. */
        async connected<T>(stream: Promise<T>) {
            const result = await stream;
            clear();

            return result;
        },
    };
}
