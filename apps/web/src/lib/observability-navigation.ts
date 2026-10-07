import { metricNames, registryMetricNames, type MachineMetricName } from "@stoat/api/observability";

export const observabilityViews = [
    { id: "overview", title: "Overview", href: "/observability" },
    { id: "dns", title: "DNS", href: "/observability/dns" },
    { id: "http", title: "HTTP traffic", href: "/observability/http" },
    { id: "registry", title: "Registry", href: "/observability/registry" },
    { id: "services", title: "Services", href: "/observability/services" },
    { id: "health", title: "Collection health", href: "/observability/health" },
] as const;

export type ObservabilityView = (typeof observabilityViews)[number]["id"];

export function observabilityView(pathname: string) {
    return observabilityViews.find((view) => view.href === pathname.replace(/\/$/, ""));
}

/** Keep the monitoring scope, not unrelated page/dialog state, when switching views. */
export function observabilityHref(href: string, url: URL) {
    const params = new URLSearchParams();

    if (observabilityView(url.pathname)) {
        for (const key of ["clusters", "machine", "range", "from", "to", "paused", "q"]) {
            const value = url.searchParams.get(key);

            if (value !== null) params.set(key, value);
        }
    }

    const search = params.toString();

    return search ? `${href}?${search}` : href;
}

/** Request only the metrics rendered by the current view. */
export function observabilityMetrics(view: ObservabilityView): readonly MachineMetricName[] {
    switch (view) {
        case "dns":
            return ["dnsQueries", "dnsErrors", "dnsAvailability"];
        case "health":
            return ["dnsAvailability"];
        case "registry":
            return registryMetricNames;
        // HTTP traffic has its own page with service-scoped queries.
        case "http":
            return [];
        case "services":
            return metricNames.filter((name) => name.startsWith("service"));
        case "overview":
            return metricNames.filter((name) => !name.startsWith("service"));
    }
}
