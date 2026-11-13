import { rekeySecrets } from "@clowder/api/rebrand";
import { databaseUrl } from "@clowder/config/env";
import { createDb } from "@clowder/db";

// Runs in the pre-deploy hook after the migrations: see `rekeySecrets`.
const db = createDb({ DATABASE_URL: databaseUrl() });

try {
    console.log(`[rebrand] re-encrypted ${await rekeySecrets(db)} secret(s).`);
} finally {
    await db.$client.end();
}
