import { apiKey } from "@better-auth/api-key";
import type { Database } from "@stoat/db";
import * as schema from "@stoat/db/schema/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins/admin";
import { organization } from "better-auth/plugins/organization";
import { listUserOrganizations } from "@stoat/db/organizations";

export type AuthConfig = {
    APP_URL: string;
    APP_SECRET: string;
};

// Named so tsc emits a reference instead of inlining the plugin's huge type (TS7056).
interface ApiKeyPlugin extends ReturnType<typeof apiKey> {}

export function createAuth(env: AuthConfig, database: Database) {
    return betterAuth({
        database: drizzleAdapter(database, {
            provider: "pg",
            schema,
        }),
        databaseHooks: {
            session: {
                create: {
                    before: async (session) => {
                        const [organization] = await listUserOrganizations(
                            database,
                            session.userId,
                        );

                        return {
                            data: { ...session, activeOrganizationId: organization?.id ?? null },
                        };
                    },
                },
            },
        },
        trustedOrigins: [env.APP_URL],
        emailAndPassword: { enabled: true },
        secret: env.APP_SECRET,
        baseURL: env.APP_URL,
        plugins: [
            organization(),
            admin(),
            // Org-owned keys, sent as `x-api-key`. Only org owners can manage them by default.
            apiKey({
                references: "organization",
                defaultPrefix: "stoat_",
                rateLimit: { enabled: false },
            }) as ApiKeyPlugin,
        ],
    });
}
