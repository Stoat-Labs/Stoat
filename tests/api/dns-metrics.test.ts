import { expect, it } from "vite-plus/test";
import { assembleCluster, chartSeries, machineList } from "../../apps/web/src/lib/observability";
import {
    dnsMetricNames,
    dnsMetricQueries,
    parseMetricSeries,
    postgresMetricQueries,
} from "../../packages/api/src/observability";

it("scopes DNS rates and scrape health to the cluster's Uncloud targets", () => {
    const queries = dnsMetricQueries("cluster-id", 120);
    expect(queries.dnsQueries).toBe(
        'sum by (machine_id) (rate(uncloud_dns_query_total{customer_id="cluster-id",job="prometheus.scrape.uncloud"}[240s]))',
    );
    expect(queries.dnsAvailability).toBe(
        'min by (machine_id) (min_over_time(up{customer_id="cluster-id",job="prometheus.scrape.uncloud"}[120s]))',
    );
    expect(dnsMetricQueries("cluster-id", 15).dnsQueries).toContain("[60s]");
});

it("keeps failed scrapes and missing intervals distinct from successful scrapes", () => {
    const series = parseMetricSeries(
        JSON.stringify({
            status: "success",
            data: {
                resultType: "matrix",
                result: [
                    {
                        metric: { machine_id: "machine" },
                        values: [
                            [120, "1"],
                            [240, "0"],
                            [480, "1"],
                        ],
                    },
                ],
            },
        }),
        120,
        480,
        120,
    );

    expect(series[0]?.points.map((point) => point.value)).toEqual([1, 0, null, 1]);
});

it("uses observability's cluster-qualified machine identities and filters for DNS metrics", () => {
    const clusters = ["first", "second"].map((id, index) =>
        assembleCluster(
            { id, name: id },
            { data: [{ id: "machine", name: "Host", state: "up" }], error: null, isPending: false },
            { data: [], error: null, isPending: false },
            dnsMetricNames.map((name) => ({
                data: {
                    start: 120,
                    end: 240,
                    step: 120,
                    series:
                        name === "dnsAvailability" && index === 1
                            ? []
                            : [
                                  {
                                      machineId: "machine",
                                      serviceId: "",
                                      container: "",
                                      points: [{ time: 240000, value: index + 1 }],
                                  },
                              ],
                },
                error: null,
                isPending: false,
            })),
            dnsMetricNames,
        ),
    );

    const machines = machineList(clusters);

    expect(chartSeries(machines, "dnsQueries").map((series) => series.machineKey)).toEqual([
        "first:machine",
        "second:machine",
    ]);
    expect(
        chartSeries(
            machines.filter((machine) => machine.key === "second:machine"),
            "dnsQueries",
        )[0]?.points,
    ).toEqual([{ time: 240000, value: 2 }]);
    expect(chartSeries(machines, "dnsAvailability")[1]?.points).toEqual([]);
});

it("scopes Postgres exporter metrics to the resource's services and skips template databases", () => {
    const queries = postgresMetricQueries("cluster-id", 15, ["service-a", "service-b"]);
    const scope =
        'customer_id="cluster-id",container_label_uncloud_service_id=~"service-a|service-b"';

    expect(queries.postgresSize).toBe(
        `sum by (machine_id) (pg_database_size_bytes{${scope},datname!~"template.*"})`,
    );
    expect(queries.postgresMaxConnections).toBe(
        `max by (machine_id) (pg_settings_max_connections{${scope}})`,
    );
    expect(queries.postgresTransactions).toContain("[60s]");
});
