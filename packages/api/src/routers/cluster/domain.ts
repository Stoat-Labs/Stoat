import { ORPCError } from "@orpc/server";
import { UcApiError, unwrap, type UcClient } from "@stoat/uncloud";
import { isClusterDomain } from "@stoat/workflows/ingress";
import * as v from "valibot";
import {
    isOrganizationAdmin,
    organizationAdminProcedure,
    organizationProcedure,
    uncloudMiddleware,
} from "../..";

const clusterId = v.pipe(v.string(), v.uuid());

const domainName = v.pipe(
    v.string(),
    v.trim(),
    v.toLowerCase(),
    v.transform((name) => name.replace(/\.$/u, "")),
    v.check(isClusterDomain, "Enter a domain such as apps.example.com."),
);

// Releasing a uncld.dev domain is permanent: Uncloud DNS can't give the name back yet.
const release = v.optional(v.boolean(), false);

type Domain = { domain: string; reserved: boolean };

/** The cluster's domain, or null when it has none. */
function currentDomain(uc: UcClient, signal?: AbortSignal) {
    return unwrap(uc.GET("/api/v1/cluster/domain", { signal })).catch((error: Error) => {
        if (error instanceof UcApiError && error.status === 404) return null;

        throw error;
    });
}

// Uncloud's own reasons, such as an invalid name, are worth showing as they are.
function sidecarRequest<T>(request: Promise<{ data?: T; error?: unknown; response: Response }>) {
    return unwrap(request).catch((error: Error) => {
        if (error instanceof UcApiError && error.status < 500)
            throw new ORPCError("BAD_REQUEST", { message: error.message });

        throw error;
    });
}

async function clearDomain(uc: UcClient, current: Domain, confirmed: boolean) {
    if (current.reserved && !confirmed)
        throw new ORPCError("CONFLICT", {
            message: `Confirm releasing ${current.domain}, which can't be reserved again.`,
        });

    await sidecarRequest(uc.DELETE("/api/v1/cluster/domain"));
}

export const domainRouter = {
    getDomain: organizationProcedure
        .input(v.object({ clusterId }))
        .use(uncloudMiddleware)
        .handler(async ({ context: { uc, organizationRole }, signal }) => {
            const current = await currentDomain(uc, signal);

            return {
                domain: current?.domain ?? null,
                // Reserved in Uncloud DNS, which keeps its records up to date.
                reserved: current?.reserved ?? false,
                canManage: isOrganizationAdmin(organizationRole),
            };
        }),

    // Uncloud keeps one domain, so a different one replaces it.
    setDomain: organizationAdminProcedure
        .input(v.object({ clusterId, domain: domainName, release }))
        .use(uncloudMiddleware)
        .handler(async ({ context: { uc }, input }) => {
            const current = await currentDomain(uc);

            if (current?.domain === input.domain) return;

            if (current) await clearDomain(uc, current, input.release);

            await sidecarRequest(
                uc.PUT("/api/v1/cluster/domain", { body: { name: input.domain } }),
            );
        }),

    clearDomain: organizationAdminProcedure
        .input(v.object({ clusterId, release }))
        .use(uncloudMiddleware)
        .handler(async ({ context: { uc }, input }) => {
            const current = await currentDomain(uc);

            if (current) await clearDomain(uc, current, input.release);
        }),
};
