import { expect, it } from "vite-plus/test";
import {
    observabilityHref,
    observabilityMetrics,
    observabilityView,
    observabilityViews,
} from "../../apps/web/src/lib/observability-navigation";
import {
    dnsMetricNames,
    metricNames,
    registryMetricNames,
} from "../../packages/api/src/observability";

it("resolves each observability page without marking overview active for every child", () => {
    for (const view of observabilityViews) {
        expect(observabilityView(view.href)).toEqual(view);
        expect(observabilityView(`${view.href}/`)).toEqual(view);
    }

    expect(observabilityView("/observability/unknown")).toBeUndefined();
    expect(observabilityView("/projects")).toBeUndefined();
});

it("preserves monitoring scope and time range between pages, excluding unrelated UI state", () => {
    const url = new URL(
        "https://stoat.test/observability?clusters=a,b&machine=a:node&range=6h&from=100&to=200&paused=true&q=api&dialog=open",
    );

    const target = new URL(observabilityHref("/observability/dns", url), url);
    expect(target.pathname).toBe("/observability/dns");

    for (const key of ["clusters", "machine", "range", "from", "to", "paused", "q"]) {
        expect(target.searchParams.get(key)).toBe(url.searchParams.get(key));
    }

    expect(target.searchParams.has("dialog")).toBe(false);
    expect(
        observabilityHref("/observability", new URL("https://stoat.test/projects?q=other")),
    ).toBe("/observability");
    expect(
        observabilityHref("/observability/dns", new URL("https://stoat.test/observability")),
    ).toBe("/observability/dns");
});

it("partitions the existing metrics into focused pages without dropping any", () => {
    const metrics = observabilityViews.flatMap((view) => observabilityMetrics(view.id));
    const expected = [...new Set([...metricNames, ...dnsMetricNames, ...registryMetricNames])];
    expect([...new Set(metrics)].toSorted()).toEqual(expected.toSorted());
    expect(observabilityMetrics("dns")).toEqual(["dnsQueries", "dnsErrors", "dnsAvailability"]);
    expect(observabilityMetrics("health")).toEqual(["dnsAvailability"]);
    expect(observabilityMetrics("services").every((name) => name.startsWith("service"))).toBe(true);
    expect(observabilityMetrics("overview").some((name) => name.startsWith("service"))).toBe(false);
});
