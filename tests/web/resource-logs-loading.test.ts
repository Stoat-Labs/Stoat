import { expect, it, vi } from "vite-plus/test";
import { render } from "svelte/server";
import { setContext } from "svelte";
import ResourceLogs from "../../apps/web/src/lib/components/projects/resource-logs.svelte";

const { createQuery } = vi.hoisted(() => ({ createQuery: vi.fn() }));

vi.mock("@tanstack/svelte-query", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@tanstack/svelte-query")>()),
    createQuery,
}));

it("keeps the logs workspace skeleton until both queries are ready", () => {
    for (const [resourcePending, servicesPending] of [
        [true, true],
        [true, false],
        [false, true],
        [false, false],
    ]) {
        createQuery.mockReturnValueOnce({ isPending: resourcePending });
        createQuery.mockReturnValueOnce({ isPending: servicesPending, data: { services: [] } });
        createQuery.mockReturnValueOnce({ data: [] });
        createQuery.mockReturnValueOnce({ data: [] });

        function LogsWithContext(...args: Parameters<typeof ResourceLogs>) {
            setContext(Symbol.for("nuqs-svelte-adapter"), {
                useAdapter: () => ({ searchParams: () => new URLSearchParams() }),
            });

            return ResourceLogs(...args);
        }

        const { body } = render(LogsWithContext, {
            props: { projectId: "project", resourceId: "resource" },
        });

        if (resourcePending || servicesPending) {
            expect(body).toContain('loading-label="Loading logs"');
            expect(body).toContain('data-slot="frame"');
            expect(body).toContain('aria-label="Filter loaded logs"');
            expect(body).toContain('aria-label="Log activity"');
            expect(body.match(/class="log-row /g)).toHaveLength(16);
            expect(body).not.toContain("No deployed services");
        } else {
            expect(body).toContain("No deployed services");
            expect(body).not.toContain("<phantom-ui");
        }
    }
});

it("restores the search controls from a shared URL", () => {
    createQuery.mockReturnValueOnce({ isPending: false });
    createQuery.mockReturnValueOnce({
        isPending: false,
        data: { services: [{ id: "service-1", name: "api" }], historyAvailable: true },
    });
    createQuery.mockReturnValueOnce({ data: [] });
    createQuery.mockReturnValueOnce({ data: [] });

    function LogsWithUrl(...args: Parameters<typeof ResourceLogs>) {
        setContext(Symbol.for("nuqs-svelte-adapter"), {
            useAdapter: () => ({
                searchParams: () =>
                    new URLSearchParams(
                        "logMode=search&logRange=custom&logLevel=error&logWrap=true",
                    ),
            }),
        });

        return ResourceLogs(...args);
    }

    const { body } = render(LogsWithUrl, {
        props: { projectId: "project", resourceId: "resource" },
    });

    expect(body).toContain('aria-label="Search log messages"');
    expect(body).toContain('id="log-start"');
    expect(body).toContain('aria-label="Wrap log lines"');
    expect(body).toContain('aria-pressed="true"');
});

it("restores pause and scroll controls from a shared URL", () => {
    createQuery.mockReturnValueOnce({ isPending: false });
    createQuery.mockReturnValueOnce({
        isPending: false,
        data: { services: [{ id: "service-1", name: "api" }], historyAvailable: true },
    });
    createQuery.mockReturnValueOnce({ data: [] });
    createQuery.mockReturnValueOnce({ data: [] });

    function LogsWithUrl(...args: Parameters<typeof ResourceLogs>) {
        setContext(Symbol.for("nuqs-svelte-adapter"), {
            useAdapter: () => ({
                searchParams: () =>
                    new URLSearchParams("logPaused=true&logFollowing=false&logScroll=42"),
            }),
        });

        return ResourceLogs(...args);
    }

    const { body } = render(LogsWithUrl, {
        props: { projectId: "project", resourceId: "resource" },
    });

    expect(body).toContain("Resume");
    expect(body).toContain("Jump to latest");
});

it("restores a fixed time bucket from a shared URL", () => {
    createQuery.mockReturnValueOnce({ isPending: false });
    createQuery.mockReturnValueOnce({
        isPending: false,
        data: { services: [{ id: "service-1", name: "api" }], historyAvailable: true },
    });
    createQuery.mockReturnValueOnce({ data: [] });
    createQuery.mockReturnValueOnce({ data: [] });

    function LogsWithUrl(...args: Parameters<typeof ResourceLogs>) {
        setContext(Symbol.for("nuqs-svelte-adapter"), {
            useAdapter: () => ({
                searchParams: () => new URLSearchParams("logBucket=0%3A0%3A24000"),
            }),
        });

        return ResourceLogs(...args);
    }

    const { body } = render(LogsWithUrl, {
        props: { projectId: "project", resourceId: "resource" },
    });

    expect(body).toContain("Show all times");
});
