import type { Database } from "@stoat/db";

/**
 * Drops a per-test database once its pools have really disconnected. `pool.end()` can
 * resolve before Postgres has seen every Terminate; `WITH (FORCE)` would then kill a
 * closing client, which pg reports as an unhandled error that fails the whole run.
 */
export async function dropTestDatabase(admin: Database, name: string) {
    for (let attempt = 0; attempt < 50; attempt++) {
        const { rows } = await admin.$client.query<{ sessions: number }>(
            "SELECT count(*)::int AS sessions FROM pg_stat_activity WHERE datname = $1",
            [name],
        );

        if (rows[0]?.sessions === 0) break;
        await new Promise((done) => setTimeout(done, 100));
    }

    await admin.$client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
}
