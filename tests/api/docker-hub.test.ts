import { describe, expect, it } from "vite-plus/test";
import { dockerHubLogoUrl, dockerHubRepository } from "../../packages/api/src/docker-hub";

describe("dockerHubRepository", () => {
    it.each([
        ["postgres", "library/postgres"],
        ["postgres:18-alpine", "library/postgres"],
        ["Traefik/Whoami:v1.10", "traefik/whoami"],
        ["sbx/playwright-kit@sha256:" + "a".repeat(64), "sbx/playwright-kit"],
        ["docker.io/library/nginx:1.27", "library/nginx"],
        ["docker.io/nginx", "library/nginx"],
    ])("maps %j to %j", (image, repository) => {
        expect(dockerHubRepository(image)).toBe(repository);
    });

    it.each([
        "ghcr.io/org/app:1",
        "localhost/app",
        "registry.example.com:5000/team/app:latest",
        "quay.io/org/app",
        "",
        "docker.io",
    ])("skips %j", (image) => {
        expect(dockerHubRepository(image)).toBeNull();
    });
});

describe("dockerHubLogoUrl", () => {
    it("encodes the repository path", () => {
        expect(dockerHubLogoUrl("sbx/playwright-kit")).toBe(
            "https://hub.docker.com/api/media/repos_logo/v1/sbx%2Fplaywright-kit?type=logo",
        );
    });
});
