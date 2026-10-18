import { describe, expect, it } from "vite-plus/test";

import {
    addVolume,
    attachVolume,
    ComposeVolumeError,
    detachVolume,
    nextVolumeName,
    pinnedVolumeName,
    remountVolume,
    removeVolume,
    volumeMounts,
} from "../../packages/api/src/compose-volumes";
import { composeVolumes } from "../../packages/api/src/project-graph";

const mountedBy = (text: string) =>
    composeVolumes(text).map(({ name, services }) => ({ name, services }));

const compose = `services:
  web:
    image: nginx
  db:
    image: postgres
`;

describe("addVolume", () => {
    it("declares the volume and mounts it", () => {
        const next = addVolume(compose, "data", "db", "/var/lib/postgresql");

        expect(mountedBy(next)).toEqual([{ name: "data", services: ["db"] }]);
        expect(next).toContain("- data:/var/lib/postgresql");
    });

    it("refuses an existing name, a missing service and a relative path", () => {
        const next = addVolume(compose, "data", "db", "/data");

        expect(() => addVolume(next, "data", "web", "/data")).toThrow(ComposeVolumeError);
        expect(() => addVolume(compose, "data", "nope", "/data")).toThrow(ComposeVolumeError);
        expect(() => addVolume(compose, "data", "web", "data")).toThrow(ComposeVolumeError);
        expect(() => addVolume(compose, "../data", "web", "/data")).toThrow(ComposeVolumeError);
    });
});

describe("attachVolume and detachVolume", () => {
    const withData = addVolume(compose, "data", "db", "/data");

    it("keeps the volume declared after its last service detaches", () => {
        const detached = detachVolume(withData, "data", "db");

        expect(mountedBy(detached)).toEqual([{ name: "data", services: [] }]);
        expect(detached).not.toContain("db:\n    image: postgres\n    volumes");
    });

    it("attaches a declared volume to another service", () => {
        const attached = attachVolume(withData, "data", "web", "/srv");

        expect(mountedBy(attached)).toEqual([{ name: "data", services: ["web", "db"] }]);
    });

    it("refuses an undeclared volume and a service that does not mount it", () => {
        expect(() => attachVolume(withData, "other", "web", "/srv")).toThrow(ComposeVolumeError);
        expect(() => detachVolume(withData, "data", "web")).toThrow(ComposeVolumeError);
    });

    it("detaches the long mount syntax too", () => {
        const long = `services:
  db:
    image: postgres
    volumes:
      - type: volume
        source: data
        target: /data
volumes:
  data: {}
`;

        expect(mountedBy(detachVolume(long, "data", "db"))).toEqual([
            { name: "data", services: [] },
        ]);
    });
});

describe("removeVolume", () => {
    it("drops an unmounted volume and the empty section", () => {
        const detached = detachVolume(addVolume(compose, "data", "db", "/data"), "data", "db");

        expect(removeVolume(detached, "data")).not.toContain("volumes");
    });

    it("unmounts it from every service first", () => {
        const shared = attachVolume(
            addVolume(compose, "data", "db", "/data"),
            "data",
            "web",
            "/srv",
        );

        const removed = removeVolume(shared, "data");

        expect(volumeMounts(removed)).toEqual([]);
        expect(removed).not.toContain("volumes");
        expect(removed).toContain("image: postgres");
    });
});

describe("volumeMounts, nextVolumeName and remountVolume", () => {
    const withData = addVolume(compose, "db-volume", "db", "/data");

    it("reads where each service mounts a volume", () => {
        expect(volumeMounts(withData)).toEqual([
            { volume: "db-volume", service: "db", target: "/data" },
        ]);
    });

    it("names a volume after its service and numbers it when taken", () => {
        expect(nextVolumeName(compose, "web")).toBe("web-volume");
        expect(nextVolumeName(withData, "db")).toBe("db-volume-2");
    });

    it("changes the mount path and keeps the mount options", () => {
        const readonly = `services:
  db:
    image: postgres
    volumes:
      - data:/data:ro
volumes:
  data: {}
`;

        expect(volumeMounts(remountVolume(readonly, "data", "db", "/var/lib"))).toEqual([
            { volume: "data", service: "db", target: "/var/lib" },
        ]);
        expect(remountVolume(readonly, "data", "db", "/var/lib")).toContain("data:/var/lib:ro");
        expect(() => remountVolume(readonly, "data", "db", "lib")).toThrow(ComposeVolumeError);
    });
});

describe("shared lists, repeated mounts and pinned names", () => {
    const shared = `x-shared: &shared
  - data:/data
  - cache:/cache
services:
  web:
    image: nginx
    volumes: *shared
  worker:
    image: nginx
    volumes: *shared
volumes:
  data: {}
  cache: {}
  extra: {}
`;

    it("keeps a service's shared mounts when another volume is attached", () => {
        const next = attachVolume(shared, "extra", "web", "/extra");

        expect(volumeMounts(next).filter((mount) => mount.service === "web")).toEqual([
            { volume: "data", service: "web", target: "/data" },
            { volume: "cache", service: "web", target: "/cache" },
            { volume: "extra", service: "web", target: "/extra" },
        ]);
        // The other service keeps the shared list as it was.
        expect(volumeMounts(next).filter((mount) => mount.service === "worker")).toHaveLength(2);
    });

    it("detaches from one service without touching the others sharing the list", () => {
        const next = detachVolume(shared, "data", "web");

        expect(volumeMounts(next).filter((mount) => mount.service === "web")).toEqual([
            { volume: "cache", service: "web", target: "/cache" },
        ]);
        expect(volumeMounts(next).filter((mount) => mount.service === "worker")).toHaveLength(2);
    });

    it("moves one of several paths of the same volume", () => {
        const twice = `services:
  web:
    image: nginx
    volumes:
      - data:/a
      - data:/b
volumes:
  data: {}
`;

        expect(
            volumeMounts(remountVolume(twice, "data", "web", "/c", "/b")).map(
                (mount) => mount.target,
            ),
        ).toEqual(["/a", "/c"]);
        expect(volumeMounts(detachVolume(twice, "data", "web"))).toEqual([]);
    });

    it("reads the Docker name a volume is pinned to", () => {
        const pinned = `services:
  web:
    image: nginx
volumes:
  data:
    name: old-slug-data
  other: {}
`;

        expect(pinnedVolumeName(pinned, "data")).toBe("old-slug-data");
        expect(pinnedVolumeName(pinned, "other")).toBeUndefined();
    });
});
