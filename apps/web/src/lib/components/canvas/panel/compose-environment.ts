import * as v from "valibot";
import { parse } from "yaml";

const scalar = v.pipe(v.union([v.string(), v.number(), v.boolean()]), v.transform(String));

const composeSchema = v.object({
    services: v.fallback(
        v.record(
            v.string(),
            v.object({
                environment: v.fallback(
                    v.union([v.array(v.string()), v.record(v.string(), v.nullable(scalar))]),
                    [],
                ),
            }),
        ),
        {},
    ),
});

/** The `environment` entries each Compose service sets itself; pass-through keys without a value are left out. */
export function composeEnvironment(compose: string) {
    let services: v.InferOutput<typeof composeSchema>["services"] = {};

    try {
        services = v.parse(composeSchema, parse(compose)).services;
    } catch {
        // An unparsable draft just has no Compose variables to show.
    }

    return Object.entries(services).flatMap(([service, { environment }]) => {
        const entries = Array.isArray(environment)
            ? environment.flatMap((item) => {
                  const split = item.indexOf("=");

                  return split === -1 ? [] : [[item.slice(0, split), item.slice(split + 1)]];
              })
            : Object.entries(environment).flatMap(([key, value]) =>
                  value === null ? [] : [[key, value]],
              );

        return entries.map(([key = "", value = ""]) => ({ service, key, value }));
    });
}
