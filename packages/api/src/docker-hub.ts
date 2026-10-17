import * as v from "valibot";

const HUB = "https://hub.docker.com";

// Docker Hub serves browsers without credentials; identify as one and nothing more.
const HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

const TIMEOUT = 5_000;

// Larger logos are skipped instead of stored in the resource row.
const MAX_LOGO_BYTES = 512 * 1024;

const searchSchema = v.object({
    results: v.array(
        v.object({
            repo_name: v.string(),
            short_description: v.nullish(v.string()),
            pull_count: v.nullish(v.number()),
            is_official: v.nullish(v.boolean()),
        }),
    ),
});

export type DockerHubImage = {
    /** The reference to pull: `postgres` for official images, `owner/name` otherwise. */
    image: string;
    description: string | null;
    official: boolean;
    pulls: number;
    /** Redirects to the logo, or 404s when the repository has none. */
    logo: string;
};

/**
 * The Docker Hub repository `image` pulls from, as `namespace/name`, or `null` for other registries.
 * `postgres:18` is `library/postgres`; `ghcr.io/org/app` is `null`.
 */
export function dockerHubRepository(image: string) {
    const path = image
        .trim()
        .toLowerCase()
        .split("@")[0]
        ?.replace(/:[^/]*$/u, "");

    const segments = path ? path.split("/") : [];
    const [first] = segments;

    if (!first) return null;

    // A first segment with a dot or port, or `localhost`, names a registry.
    const registry = first.includes(".") || first.includes(":") || first === "localhost";
    const hub = ["docker.io", "index.docker.io", "registry-1.docker.io"].includes(first);
    const repository = hub ? segments.slice(1) : segments;

    if ((registry && !hub) || repository.length === 0 || repository.some((part) => !part)) {
        return null;
    }

    return repository.length === 1 ? `library/${repository[0]}` : repository.join("/");
}

/** The Docker Hub logo URL for a `namespace/name` repository. */
export function dockerHubLogoUrl(repository: string) {
    return `${HUB}/api/media/repos_logo/v1/${encodeURIComponent(repository)}?type=logo`;
}

/** Docker Hub repositories matching `query`; empty when Docker Hub is unreachable. */
export async function searchDockerHub(query: string, limit: number) {
    const url = new URL("/v2/search/repositories/", HUB);
    url.searchParams.set("query", query);
    url.searchParams.set("page_size", String(limit));

    try {
        const response = await fetch(url, {
            headers: HEADERS,
            signal: AbortSignal.timeout(TIMEOUT),
        });

        if (!response.ok) return [];

        const parsed = v.safeParse(searchSchema, await response.json());

        if (!parsed.success) return [];

        return parsed.output.results.map((result): DockerHubImage => ({
            image: result.repo_name,
            description: result.short_description || null,
            official: result.is_official ?? false,
            pulls: result.pull_count ?? 0,
            logo: dockerHubLogoUrl(
                result.repo_name.includes("/") ? result.repo_name : `library/${result.repo_name}`,
            ),
        }));
    } catch {
        return [];
    }
}

/** `image`'s Docker Hub logo as a data URI, or `null` when it has none or Docker Hub fails. */
export async function fetchDockerHubLogo(image: string) {
    const repository = dockerHubRepository(image);

    if (!repository) return null;

    try {
        const response = await fetch(dockerHubLogoUrl(repository), {
            headers: HEADERS,
            signal: AbortSignal.timeout(TIMEOUT),
        });

        const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";

        if (!response.ok || !type.startsWith("image/")) return null;

        const bytes = Buffer.from(await response.arrayBuffer());

        if (bytes.byteLength > MAX_LOGO_BYTES) return null;

        return `data:${type};base64,${bytes.toString("base64")}`;
    } catch {
        return null;
    }
}
