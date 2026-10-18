import { ORPCError } from "@orpc/client";

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
