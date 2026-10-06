import { ucClient } from "@stoat/uncloud";
import { expect, it } from "vite-plus/test";
import { deployCompose } from "../../packages/workflows/src/deploy-compose";

it("keeps diagnostics while masking merged, list, multiline, URL and overlapping credentials", async () => {
    const secrets = [
        "merge-secret",
        "list-secret",
        "line one\nline two",
        "url%20password",
        "url password",
        "short",
        "short-long",
        "x",
        "inline-secret",
    ];

    const diagnostic = `Image pull failed: ${secrets.join("; ")}. Registry denied access.`;

    const uc = ucClient("http://sidecar.test", {
        fetch: async () =>
            new Response(
                `data: ${JSON.stringify({ type: "error", error: `\u001b[31m${diagnostic}\u001b[0m` })}\n\n`,
                { headers: { "content-type": "text/event-stream" } },
            ),
    });

    const logs: string[] = [];

    const compose = `
x-env: &env
  PASSWORD: merge-secret
  CERT: |-
    line one
    line two
services:
  web:
    image: nginx
    environment:
      <<: *env
      URL: postgres://user:url%20password@db/database
    build:
      args:
        TOKEN: short-long
  db:
    image: postgres
    environment: [TOKEN=list-secret, SMALL=x, PASS=short]
secrets:
  key:
    content: inline-secret
`;

    const expected = `Image pull failed: ${secrets.map(() => "[REDACTED]").join("; ")}. Registry denied access.`;

    await expect(
        deployCompose(uc, compose, new AbortController().signal, async (text) => {
            logs.push(text);
        }),
    ).rejects.toThrow(expected);
    expect(logs).toEqual([expected]);
});

it("reports monotonic progress from plan operations", async () => {
    const events = [
        {
            type: "plan",
            operations: [
                { action: "run", resource: "a" },
                { action: "run", resource: "b" },
            ],
        },
        { type: "progress", id: "a", phase: "done" },
        { type: "progress", id: "a", phase: "done" },
        { type: "progress", id: "b", phase: "done" },
        { type: "progress", id: "extra", phase: "done" },
        { type: "complete" },
    ];

    const uc = ucClient("http://sidecar.test", {
        fetch: async () =>
            new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
                headers: { "content-type": "text/event-stream" },
            }),
    });

    const progress: number[] = [];

    await deployCompose(
        uc,
        "services:\n  web:\n    image: nginx\n",
        new AbortController().signal,
        async () => {},
        undefined,
        [],
        async (percent) => {
            progress.push(percent);
        },
    );
    expect(progress).toEqual([10, 53, 95]);
});

it("does not mask service names or values without letters or digits", async () => {
    const error = 'service "seafile-ai" refers to undefined volume /opt/seafile-data';

    const uc = ucClient("http://sidecar.test", {
        fetch: async () =>
            new Response(`data: ${JSON.stringify({ type: "error", error })}\n\n`, {
                headers: { "content-type": "text/event-stream" },
            }),
    });

    const logs: string[] = [];

    await expect(
        deployCompose(
            uc,
            "services:\n  seafile-ai:\n    image: x\n    environment: [DB_USER=seafile, ROOT=/, PASS=data]\n",
            new AbortController().signal,
            async (text) => {
                logs.push(text);
            },
        ),
    ).rejects.toThrow();
    expect(logs).toEqual([
        'service "seafile-ai" refers to undefined volume /opt/seafile-[REDACTED]',
    ]);
});

it("masks only the given credentials when the environment is public", async () => {
    const error = "stoat-monitoring-alloy failed to reach monitoring with hunter2";

    const uc = ucClient("http://sidecar.test", {
        fetch: async () =>
            new Response(`data: ${JSON.stringify({ type: "error", error })}\n\n`, {
                headers: { "content-type": "text/event-stream" },
            }),
    });

    const logs: string[] = [];

    await expect(
        deployCompose(
            uc,
            "services:\n  alloy:\n    image: x\n    environment: [GREPTIME_USERNAME=stoat, GREPTIME_DB=monitoring, GREPTIME_PASSWORD=hunter2]\n",
            new AbortController().signal,
            async (text) => {
                logs.push(text);
            },
            undefined,
            ["hunter2"],
            undefined,
            false,
            false,
        ),
    ).rejects.toThrow();
    expect(logs).toEqual(["stoat-monitoring-alloy failed to reach monitoring with [REDACTED]"]);
});
