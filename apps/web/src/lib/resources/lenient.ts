import * as v from "valibot";

/** Drops a field with the wrong type instead of failing the whole object. */
export function lenient<TSchema extends v.GenericSchema>(schema: TSchema) {
    return v.fallback(v.optional(schema), undefined);
}
