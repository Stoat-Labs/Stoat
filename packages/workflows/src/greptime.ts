import { unwrap, type UcClient } from "@stoat/uncloud";
import { GREPTIME_SERVICE } from "./monitoring-compose";
import { Schema } from "effect";

export class GreptimeResponseTooLargeError extends Error {
    constructor() {
        super("Monitoring database response exceeds 1 MiB.");
    }
}

export function readSqlRows(stdout: string): unknown[][] {
    const result = Schema.decodeUnknownSync(
        Schema.Struct({
            code: Schema.optionalKey(Schema.Number),
            error: Schema.optionalKey(Schema.String),
            output: Schema.optionalKey(
                Schema.Array(
                    Schema.Struct({
                        records: Schema.optionalKey(
                            Schema.Struct({
                                rows: Schema.optionalKey(
                                    Schema.Array(Schema.Array(Schema.Unknown)),
                                ),
                            }),
                        ),
                    }),
                ),
            ),
        }),
    )(JSON.parse(stdout));

    if (result.error || (result.code !== undefined && result.code !== 0) || !result.output)
        throw new Error("Monitoring database query failed.");

    return result.output.flatMap((output) => output.records?.rows?.map((row) => [...row]) ?? []);
}

export async function sql(uc: UcClient, password: string, query: string, signal: AbortSignal) {
    return readSqlRows(
        await monitoringRequest(
            uc,
            password,
            "/v1/sql?db=public",
            new URLSearchParams({ sql: query }),
            signal,
        ),
    );
}

/** Query the private monitoring HTTP API, which the sidecar reaches over the cluster network. */
export async function monitoringRequest(
    uc: UcClient,
    password: string,
    path: string,
    parameters: URLSearchParams,
    signal: AbortSignal,
) {
    const result = await unwrap(
        uc.POST("/api/v1/services/{name}/http", {
            params: { path: { name: GREPTIME_SERVICE } },
            body: {
                port: 4000,
                path,
                form: Object.fromEntries(parameters),
                headers: {
                    Authorization: `Basic ${Buffer.from(`stoat:${password}`).toString("base64")}`,
                },
            },
            signal,
        }),
    );

    if (result.truncated) throw new GreptimeResponseTooLargeError();

    if (result.status < 200 || result.status >= 300)
        throw new Error("Monitoring database query failed.");

    return result.body;
}
