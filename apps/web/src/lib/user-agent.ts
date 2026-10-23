// Order matters: Edge and Opera also send "Chrome", Chrome also sends "Safari",
// iOS also sends "Mac OS X", and Android also sends "Linux".
const browsers = [
    ["Edge", /Edg\//u],
    ["Opera", /OPR\//u],
    ["Firefox", /Firefox\//u],
    ["Chrome", /Chrome\//u],
    ["Safari", /Safari\//u],
] as const;

const systems = [
    ["iOS", /iPhone|iPad/u],
    ["Android", /Android/u],
    ["Windows", /Windows/u],
    ["macOS", /Mac OS X/u],
    ["Linux", /Linux/u],
] as const;

/** A short label such as "Firefox on Linux" for the sessions list. */
export function describeUserAgent(userAgent: string | null | undefined) {
    if (!userAgent) return "Unknown device";
    const browser = browsers.find(([, pattern]) => pattern.test(userAgent))?.[0];
    const system = systems.find(([, pattern]) => pattern.test(userAgent))?.[0];

    if (browser && system) return `${browser} on ${system}`;

    return browser ?? system ?? "Unknown device";
}
