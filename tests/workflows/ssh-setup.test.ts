import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, machineState } from "@clowder/workflows/ssh-setup";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

// Runs the remote command here instead, against the machine.json next to this script.
const localSsh = `#!/bin/sh
for command; do :; done
exec sh -c "$(printf '%s' "$command" | sed "s#/var/lib/uncloud/machine.json#$(dirname "$0")/machine.json#")"
`;

const server = { host: "93.184.216.34", port: 22, user: "root" };

// Uncloud saves WireGuard keys as hex; the sidecar lists them as base64.
const PUBLIC_KEY = "5a".repeat(32);

const PRIVATE_KEY = "c3".repeat(32);

describe("reading which cluster member a server is", () => {
    const originalPath = process.env.PATH;
    let bin: string;

    beforeAll(async () => {
        bin = await mkdtemp(join(tmpdir(), "clowder-local-ssh-"));
        await writeFile(join(bin, "ssh"), localSsh);
        await chmod(join(bin, "ssh"), 0o755);
        process.env.PATH = `${bin}:${originalPath}`;
    });

    afterAll(async () => {
        process.env.PATH = originalPath;
        await rm(bin, { recursive: true, force: true });
    });

    async function read(state: string | null) {
        if (state === null) await rm(join(bin, "machine.json"), { force: true });
        else await writeFile(join(bin, "machine.json"), state);

        const workspace = await createWorkspace("clowder-ssh-test-");

        try {
            return await machineState(server, workspace, new AbortController().signal);
        } finally {
            await rm(workspace.dir, { recursive: true, force: true });
        }
    }

    it("reads the member's own ID and public key, never its private key", async () => {
        const state = {
            ID: "3f2a9c1d0b7e4a6f8c5d2e1b0a9f8e7d",
            Name: "edge",
            Network: { PrivateKey: PRIVATE_KEY, PublicKey: PUBLIC_KEY, Peers: [{ ID: "other" }] },
        };

        const expected = {
            id: state.ID,
            publicKey: Buffer.from(PUBLIC_KEY, "hex").toString("base64"),
        };

        // Uncloud writes the state with json.MarshalIndent and a two-space indent.
        expect(await read(JSON.stringify(state, null, 2))).toEqual(expected);
        expect(await read(JSON.stringify(state))).toEqual(expected);
        expect(JSON.stringify(await read(JSON.stringify(state)))).not.toContain(
            Buffer.from(PRIVATE_KEY, "hex").toString("base64"),
        );
    });

    it("finds no member on a server Uncloud is installed on but not initialised", async () => {
        const fresh = {
            ID: "",
            Name: "",
            Network: { PrivateKey: PRIVATE_KEY, PublicKey: PUBLIC_KEY },
        };

        expect(await read(JSON.stringify(fresh, null, 2))).toEqual({
            id: null,
            publicKey: Buffer.from(PUBLIC_KEY, "hex").toString("base64"),
        });
        expect(await read(null)).toEqual({ id: null, publicKey: null });
    });
});
