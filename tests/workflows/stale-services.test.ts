import { describe, expect, it } from "vite-plus/test";

import { snapshotServices, staleServices } from "../../packages/workflows/src/stale-services";

const compose = (...names: string[]) =>
    `services:\n${names.map((name) => `  ${name}:\n    image: nginx\n`).join("")}`;

describe("snapshotServices", () => {
    it("names services the way that deploy prefixed them", () => {
        expect(
            snapshotServices({ spec: compose("web", "db"), prefix: "aaaa1111-bbbb2222" }),
        ).toEqual(["aaaa1111-bbbb2222-web", "aaaa1111-bbbb2222-db"]);
    });

    it("keeps names as written when prefixes were off, and has nothing for no snapshot", () => {
        expect(snapshotServices({ spec: compose("web"), prefix: "" })).toEqual(["web"]);
        expect(snapshotServices(undefined)).toEqual([]);
        expect(snapshotServices({ spec: "not: [valid", prefix: "" })).toEqual([]);
    });
});

describe("staleServices", () => {
    it("removes a renamed service and keeps the rest", () => {
        expect(staleServices(["p-web", "p-db"], ["p-app", "p-db"], [])).toEqual(["p-web"]);
    });

    it("removes a deleted service", () => {
        expect(staleServices(["p-web", "p-worker"], ["p-web"], [])).toEqual(["p-worker"]);
    });

    it("replaces every service when prefixes are turned on or off", () => {
        expect(staleServices(["web", "db"], ["p-web", "p-db"], [])).toEqual(["db", "web"]);
        expect(staleServices(["p-web", "p-db"], ["web", "db"], [])).toEqual(["p-db", "p-web"]);
    });

    it("never removes a name another resource runs, which prefixes off allow", () => {
        expect(staleServices(["redis", "web"], ["web"], ["redis"])).toEqual([]);
    });

    it("never removes Stoat's own services", () => {
        expect(
            staleServices(
                ["caddy", "stoat-monitoring-greptimedb", "stoat-monitoring-alloy", "old"],
                [],
                [],
            ),
        ).toEqual(["old"]);
    });

    it("lists each service once, however it was found", () => {
        expect(staleServices(["p-old", "p-old"], [], [])).toEqual(["p-old"]);
    });
});
