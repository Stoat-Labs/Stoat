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

/** One warning toast per live stream: kept up to date while it retries, closed once events flow again. */
export function streamErrorToast() {
    let id: string | undefined;

    return {
        show(error: Error, reconnecting: boolean) {
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
        },
        clear() {
            if (id) toastManager.close(id);
        },
    };
}
