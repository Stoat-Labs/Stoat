import { rangePresets } from "@stoat/api/observability";
import { parseAsInteger, parseAsStringLiteral, useQueryStates } from "nuqs-svelte";

/** URL-backed time range shared by every observability view; call during component init. */
export function useObservabilityRange() {
    const filters = useQueryStates(
        {
            range: parseAsStringLiteral(rangePresets).withDefault("1h"),
            from: parseAsInteger,
            to: parseAsInteger,
        },
        { shallow: true, scroll: false },
    );

    // A custom from/to pair in the URL overrides the preset.
    const custom = () =>
        filters.from.current && filters.to.current && filters.to.current > filters.from.current
            ? { from: filters.from.current, to: filters.to.current }
            : null;

    return {
        filters,
        get custom() {
            return custom();
        },
        get value() {
            return custom() ?? filters.range.current;
        },
    };
}

export type ObservabilityRangeState = ReturnType<typeof useObservabilityRange>;
