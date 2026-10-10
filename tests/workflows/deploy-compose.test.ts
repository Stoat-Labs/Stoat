import { ucClient } from "@stoat/uncloud";
import { expect, it } from "vite-plus/test";
import { deployCompose, environmentCredentials } from "../../packages/workflows/src/deploy-compose";

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

    // `production` sits under a non-credential key and is already public in the Compose file.
    const diagnostic = `Image pull failed: ${secrets.join("; ")}. Registry denied access in production.`;

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
  TLS_KEY: |-
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
    environment: [TOKEN=list-secret, SMALL_SECRET=x, PASS=short, NODE_ENV=production]
secrets:
  key:
    content: inline-secret
`;

    const expected = `Image pull failed: ${secrets.map(() => "[REDACTED]").join("; ")}. Registry denied access in production.`;

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
            "services:\n  seafile-ai:\n    image: x\n    environment: [DB_PASSWORD=seafile, ROOT_KEY=/, PASS=data]\n",
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

it("masks given credentials but not plain environment values", async () => {
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
            "services:\n  alloy:\n    image: x\n    environment: [GREPTIME_USERNAME=stoat, GREPTIME_DB=monitoring, GREPTIME_URL=monitoring-alloy]\n",
            new AbortController().signal,
            async (text) => {
                logs.push(text);
            },
            undefined,
            ["hunter2"],
        ),
    ).rejects.toThrow();
    expect(logs).toEqual(["stoat-monitoring-alloy failed to reach monitoring with [REDACTED]"]);
});

it("masks whole values only under credential-like keys", () => {
    expect(environmentCredentials("DB_PASSWORD", "hunter2")).toEqual(["hunter2"]);
    expect(environmentCredentials("GITHUB_PAT", "ghp_x")).toEqual(["ghp_x"]);
    expect(environmentCredentials("REPLICAS", "2")).toEqual([]);
    expect(environmentCredentials("TAG", "1.27")).toEqual([]);
    expect(environmentCredentials("PATH_PREFIX", "/app")).toEqual([]);
    expect(environmentCredentials("DATABASE_URL", "postgres://app:p%40ss@db/app")).toEqual([
        "p%40ss",
        "p@ss",
    ]);
});
