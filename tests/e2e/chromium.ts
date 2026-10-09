import { existsSync, readdirSync } from "node:fs";

/** A nix store path: 32-character hash, `-chromium-`, then the dotted version. */
const chromiumStorePath = /^[a-z0-9]{32}-chromium-(\d+(?:\.\d+)*)$/u;

function compareVersions(a: number[], b: number[]): number {
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);

        if (difference !== 0) return difference;
    }

    return 0;
}

/** The newest nix store Chromium, if this host has one. */
function nixStoreChromium(): string | undefined {
    if (process.platform !== "linux" || !existsSync("/nix/store")) return undefined;

    let newest: { version: number[]; executable: string } | undefined;

    for (const entry of readdirSync("/nix/store")) {
        const match = chromiumStorePath.exec(entry);

        if (!match) continue;

        const executable = `/nix/store/${entry}/bin/chromium`;

        if (!existsSync(executable)) continue;

        const version = (match[1] ?? "").split(".").map(Number);

        if (!newest || compareVersions(version, newest.version) > 0) {
            newest = { version, executable };
        }
    }

    return newest?.executable;
}

/**
 * A Chromium this host can actually start, or `undefined` to use the one Playwright bundles.
 *
 * Playwright's downloads are linked against FHS paths, so they cannot start on NixOS. The nix
 * store has a patched Chromium; use the newest one when there is one. `PLAYWRIGHT_CHROMIUM_EXECUTABLE`
 * overrides the search for any other browser or host.
 */
export function chromiumExecutable(): string | undefined {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || nixStoreChromium();
}
