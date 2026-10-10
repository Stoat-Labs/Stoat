import { apiKey } from "@better-auth/api-key";
import type { Database } from "@stoat/db";
import * as schema from "@stoat/db/schema/auth";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { getSignupsEnabled } from "@stoat/db/settings";
import { hasPendingInvitation, isSetupRequired } from "@stoat/db/setup";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins/admin";
import { organization } from "better-auth/plugins/organization";
import { listUserOrganizations, organizationHasInfrastructure } from "@stoat/db/organizations";

import { createSessionStorage } from "./session-storage";

export type AuthConfig = {
    APP_URL: string;
    APP_SECRET: string;
    /** Dragonfly/Redis for sessions and rate limits. Unset keeps everything in Postgres. */
    REDIS_URL?: string;
};

/**
 * The client address Better Auth rate-limits by. The web server sets it on every request from
 * the connection (or its configured proxy header), replacing anything the client sent.
 */
export const CLIENT_IP_HEADER = "x-stoat-client-ip";

// Named so tsc emits a reference instead of inlining the plugin's huge type (TS7056).
interface ApiKeyPlugin extends ReturnType<typeof apiKey> {}

/**
 * `cookiePlugin` lets the host framework write cookies set by server-side auth calls
 * (SvelteKit's `sveltekitCookies`). Better Auth requires it to be the last plugin.
 */
export function createAuth(env: AuthConfig, database: Database, cookiePlugin?: BetterAuthPlugin) {
    const redisUrl = env.REDIS_URL?.trim();
    // Better Auth appends "/api/auth" verbatim, so a trailing slash would route auth to "//api/auth".
    const appUrl = env.APP_URL.replace(/\/+$/u, "");

    return betterAuth({
        database: drizzleAdapter(database, {
            provider: "pg",
            schema,
        }),
        secondaryStorage: redisUrl ? createSessionStorage(redisUrl) : undefined,
        databaseHooks: {
            user: {
                create: {
                    // The first account of a fresh install becomes the instance admin.
                    before: async (user) => ({
                        data: {
                            ...user,
                            ...((await isSetupRequired(database)) && { role: "admin" }),
                        },
                    }),
                },
            },
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
        trustedOrigins: [appUrl],
        hooks: {
            before: createAuthMiddleware(async (ctx) => {
                if (
                    ctx.path === "/sign-up/email" &&
                    !(await canSignUp(database, ctx.body?.email))
                ) {
                    throw new APIError("FORBIDDEN", { message: "User signups are disabled." });
                }
            }),
            after: createAuthMiddleware(async (ctx) => {
                // Creating an organization makes it active; reissue the session cookie so the
                // browser carries the switched session right away.
                if (ctx.path !== "/organization/create") return;

                const session = await getSessionFromCtx(ctx, { disableCookieCache: true });

                if (session) await setSessionCookie(ctx, session);
            }),
        },
        emailAndPassword: { enabled: true },
        session: {
            // No signed session snapshot in a cookie: every request reads the live session, so
            // sign-outs, revoked sessions (e.g. after a password change), and role changes apply
            // at once. With REDIS_URL set that read is a cache hit, otherwise one indexed query.
            cookieCache: { enabled: false },
            // With secondary storage, Postgres keeps a durable copy so a Dragonfly flush or
            // outage falls back to it instead of signing everyone out.
            storeSessionInDatabase: true,
        },
        // Invitation and verification tokens must survive a Dragonfly flush.
        verification: { storeInDatabase: true },
        secret: env.APP_SECRET,
        baseURL: appUrl,
        // The default, x-forwarded-for, is client-controlled without a proxy, and without any
        // header every client shares one rate-limit bucket.
        advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
        plugins: [
            organization({
                organizationHooks: {
                    beforeDeleteOrganization: async ({ organization }) => {
                        if (await organizationHasInfrastructure(database, organization.id))
                            throw new APIError("BAD_REQUEST", {
                                message:
                                    "Delete this organization's clusters and S3 connections first.",
                            });
                    },
                },
            }),
            admin(),
            // Org-owned keys, sent as `x-api-key`. Only org owners can manage them by default.
            apiKey({
                references: "organization",
                defaultPrefix: "stoat_",
                rateLimit: { enabled: false },
            }) as ApiKeyPlugin,
            ...(cookiePlugin ? [cookiePlugin] : []),
        ],
    });
}

/**
 * Closed sign-ups still admit the first account of a fresh install (the user hook makes it the
 * instance admin) and anyone holding a pending invitation.
 */
async function canSignUp(database: Database, email: string | undefined) {
    if (await getSignupsEnabled(database)) return true;

    if (await isSetupRequired(database)) return true;

    return email !== undefined && (await hasPendingInvitation(database, email));
}
