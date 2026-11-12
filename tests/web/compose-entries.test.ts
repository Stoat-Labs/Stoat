import { describe, expect, it } from "vite-plus/test";

import {
    composeEntries,
    gitInput,
} from "../../apps/web/src/lib/components/canvas/controls/add-palette-entries";

const repository = {
    connectionId: "connection",
    repositoryUrl: "https://git.example.com/acme/infrastructure.git",
};

describe("composeEntries", () => {
    it("lists only Compose files, each creating the resource from it", () => {
        const entries = composeEntries(repository, "main", [
            "README.md",
            "umami/compose.yaml",
            "deploy/docker-compose.yml",
            "notcompose.yaml",
        ]);

        expect(entries.map((entry) => entry.label)).toEqual([
            "umami/compose.yaml",
            "deploy/docker-compose.yml",
        ]);
        expect(entries[0]?.target).toEqual({
            create: {
                name: "infrastructure",
                git: { ...repository, branch: "main", path: "umami/compose.yaml" },
            },
        });
    });
});

describe("gitInput", () => {
    it("names the resource after the repository", () => {
        expect(gitInput(repository, "main", ".").name).toBe("infrastructure");
    });
});
