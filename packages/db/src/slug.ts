const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

// Room for `-<service>` within a 63-character DNS label.
const MAX_NAME = 20;

/**
 * A resource's permanent name prefix on the cluster, like `seafile-k3f9x2`: its services run
 * as `seafile-k3f9x2-server`. Picked once at creation, so renaming the resource or moving it
 * to another project never renames its containers or volumes.
 */
export function resourceSlug(name = "") {
    const base =
        name
            .normalize("NFKD")
            .toLowerCase()
            .replaceAll(/[^a-z0-9]+/gu, "-")
            .slice(0, MAX_NAME)
            .replaceAll(/^-+|-+$/gu, "") || "app";

    // 36^6 ≈ 2·10^9 per name, and the unique index catches the rest.
    const random = Array.from(
        crypto.getRandomValues(new Uint8Array(6)),
        (byte) => ALPHABET[byte % ALPHABET.length],
    ).join("");

    return `${base}-${random}`;
}
