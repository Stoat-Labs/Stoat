import { orpc } from "$lib/api/orpc";
import * as v from "valibot";

export type DatabaseInput = { clusterId: string; projectId: string; resourceId: string };

/** A read-only SQL query through the sidecar, cached like any other query. */
export function sqlQuery(input: DatabaseInput, query: string) {
    return orpc.resources.queryPostgres.queryOptions({
        input: { ...input, query },
        retry: false,
    });
}

/** Quotes an identifier for SQL, doubling any `"` inside it. */
export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Quotes a string literal for SQL, doubling any `'` inside it. */
export const quoteLiteral = (value: string) => `'${value.replaceAll("'", "''")}'`;

export const filterOperators = [
    "equals",
    "not",
    "contains",
    "greater",
    "less",
    "null",
    "notNull",
] as const;

export const filterOperatorLabels = {
    equals: "equals",
    not: "not equal",
    contains: "contains",
    greater: "greater than",
    less: "less than",
    null: "is null",
    notNull: "is not null",
} satisfies Record<(typeof filterOperators)[number], string>;

export const filterSchema = v.object({
    column: v.string(),
    operator: v.picklist(filterOperators),
    value: v.optional(v.string(), ""),
});

export type Filter = v.InferOutput<typeof filterSchema>;

/** `WHERE` for the Data view's filters, all of which must match; empty without filters. */
export function whereClause(filters: Filter[]) {
    const conditions = filters.map(({ column, operator, value }) => {
        const name = quoteIdent(column);
        const literal = quoteLiteral(value);

        switch (operator) {
            case "equals":
                return `${name} = ${literal}`;
            case "not":
                return `${name} IS DISTINCT FROM ${literal}`;
            case "contains":
                return `${name}::text ILIKE ${quoteLiteral(`%${value.replace(/[\\%_]/gu, "\\$&")}%`)}`;
            case "greater":
                return `${name} > ${literal}`;
            case "less":
                return `${name} < ${literal}`;
            case "null":
                return `${name} IS NULL`;
            case "notNull":
                return `${name} IS NOT NULL`;
        }
    });

    return conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
}

/** Row counts like the table list shows them: 12, 1.2K, 3.4M. */
export const compactCount = (count: number) =>
    new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(count);

/**
 * Every table and view with its estimated row count, plus the database's name, in one round trip.
 * Exact counts would scan every table; TimescaleDB's internal schemas are left out.
 */
export const tableListSql = `SELECT current_database(), n.nspname, c.relname,
    CASE WHEN c.reltuples < 0 THEN coalesce(s.n_live_tup, 0) ELSE c.reltuples END::bigint
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND NOT c.relispartition
    AND n.nspname <> 'information_schema' AND n.nspname NOT LIKE 'pg\\_%'
    AND n.nspname NOT LIKE '\\_timescaledb%' AND n.nspname NOT LIKE 'timescaledb\\_%'
ORDER BY n.nspname <> 'public', n.nspname, c.relname`;

export const PAGE_SIZE = 50;

/** Characters of each value a page sends; the cell's tooltip shows no more than this either. */
export const CELL_LIMIT = 256;

/**
 * One page of a table as a single JSON value: its columns and, in their order, each row's values
 * as text (a JSON number would round a bigint) cut to `CELL_LIMIT` characters, so a wide JSON or
 * text column never ships whole.
 */
export function pageSql(table: string, where: string, order: string, offset: number) {
    const regclass = `${quoteLiteral(table)}::regclass`;

    return `SELECT json_build_object(
    'columns', (
        SELECT json_agg(json_build_array(
            a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
            pg_get_expr(d.adbin, d.adrelid), coalesce(a.attnum = ANY(i.indkey), false)
        ) ORDER BY a.attnum)
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        LEFT JOIN pg_index i ON i.indrelid = a.attrelid AND i.indisprimary
        WHERE a.attrelid = ${regclass} AND a.attnum > 0 AND NOT a.attisdropped
    ),
    'rows', (
        SELECT coalesce(json_agg(cells ORDER BY position), '[]')
        FROM (
            SELECT row_number() OVER () AS position, (
                SELECT json_agg(to_json(CASE
                    WHEN length(cell.value #>> '{}') > ${CELL_LIMIT}
                    THEN left(cell.value #>> '{}', ${CELL_LIMIT}) || '…'
                    ELSE cell.value #>> '{}' END))
                FROM json_each(row_to_json(page)) cell
            ) AS cells
            FROM (SELECT * FROM ${table} ${where} ${order}
                LIMIT ${PAGE_SIZE} OFFSET ${offset}) page
        ) numbered
    )
)`;
}

const pageSchema = v.object({
    columns: v.nullable(
        v.array(
            v.tuple([v.string(), v.string(), v.boolean(), v.nullable(v.string()), v.boolean()]),
        ),
    ),
    rows: v.array(v.nullable(v.array(v.nullable(v.string())))),
});

/** Reads `pageSql`'s JSON: values as text, `null` for SQL NULL. */
export function parsePage(json: string) {
    const page = v.parse(pageSchema, JSON.parse(json));

    return {
        columns: (page.columns ?? []).map(([name, type, notNull, defaultValue, primary]) => ({
            name,
            type,
            nullable: !notNull,
            defaultValue,
            primary,
        })),
        rows: page.rows.map((cells) => cells ?? []),
    };
}
