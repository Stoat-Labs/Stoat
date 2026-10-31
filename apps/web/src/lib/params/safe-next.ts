// Only same-site paths, so a crafted link can't redirect off-site.
export function safeNextPath(value: string | null, origin: string) {
    if (!value?.startsWith("/")) return "/";

    // Browsers read "/\evil.com" as "//evil.com", so resolve the value first. Dot segments
    // can also normalise to a "//host" path, which is off-site again once used on its own.
    try {
        const target = new URL(value, origin);

        const path = `${target.pathname}${target.search}${target.hash}`;

        return target.origin === origin && !path.startsWith("//") ? path : "/";
    } catch {
        return "/";
    }
}
