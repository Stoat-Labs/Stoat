import { describe, expect, it } from "vite-plus/test";

import {
    imageServiceName,
    isImageReference,
} from "../../apps/web/src/lib/components/canvas/controls/docker-image";

describe("isImageReference", () => {
    it.each([
        "nginx",
        "nginx:1.27",
        "ghcr.io/org/app:1",
        "registry.example.com:5000/team/app:latest",
    ])("accepts %j", (image) => {
        expect(isImageReference(image)).toBe(true);
    });

    it.each(["bad image", "a:b:c", ""])("rejects %j", (image) => {
        expect(isImageReference(image)).toBe(false);
    });
});

describe("imageServiceName", () => {
    it("ignores a registry port", () => {
        expect(imageServiceName("localhost:5000/team/app:latest")).toBe("app");
    });
});
