import { render } from "svelte/server";
import { expect, it } from "vite-plus/test";
import BucketUsage from "../../apps/web/src/lib/components/s3/bucket-usage.svelte";

const GIB = 1024 ** 3;

function usage(size: number) {
    return {
        size,
        objects: 3,
        measuredAt: "2026-10-06T00:00:00.000Z",
    };
}

function arcs(body: string) {
    return [...body.matchAll(/<path[^>]* d="([^"]+)"/g)].map((match) => match[1] ?? "");
}

it("explains an unmeasured bucket instead of drawing an empty chart", () => {
    const { body } = render(BucketUsage, { props: { usage: null, quota: null } });

    expect(body).toContain("Not measured yet");
    expect(body).not.toContain("<svg");
});

it("draws only the track without a limit, so the ring never reads as full", () => {
    const { body } = render(BucketUsage, { props: { usage: usage(0), quota: null } });

    expect(body).toContain("No storage limit");
    expect(body).not.toContain("NaN");
    expect(arcs(body)).toHaveLength(1);
});

it("splits the ring into used and free space against the limit", () => {
    const { body } = render(BucketUsage, { props: { usage: usage(GIB), quota: 4 * GIB } });

    expect(body).toContain("25%");
    expect(body).toContain("of 4 GiB");
    expect(arcs(body)).toHaveLength(2);
});

it("draws an empty bucket with a limit as all free space", () => {
    const { body } = render(BucketUsage, { props: { usage: usage(0), quota: GIB } });

    expect(body).toContain("0%");
    expect(body).not.toContain("NaN");
});

it("reports usage past the limit without breaking the arc", () => {
    const { body } = render(BucketUsage, { props: { usage: usage(3 * GIB), quota: 2 * GIB } });

    expect(body).toContain("150%");
    expect(body).not.toContain("NaN");
});
