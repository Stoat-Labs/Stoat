import { clusters, member, projects, resources } from "@stoat/db/schema/index";
import { error, type RequestHandler } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import * as v from "valibot";

import { getDb } from "../../../services";

const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+)(;base64)?,(.*)$/su;

// Uploaded resource icons, which listProjectOverviews links instead of inlining. The `v` query
// changes with the icon, so browsers keep each version for good.
export const GET: RequestHandler = async ({ locals, params }) => {
    if (!locals.session) error(401);

    if (!v.is(v.pipe(v.string(), v.uuid()), params.resourceId)) error(404);

    const [row] = await getDb()
        .select({ icon: resources.icon })
        .from(resources)
        .innerJoin(projects, eq(resources.projectId, projects.id))
        .innerJoin(clusters, eq(projects.clusterId, clusters.id))
        .innerJoin(
            member,
            and(
                eq(member.organizationId, clusters.organizationId),
                eq(member.userId, locals.session.user.id),
            ),
        )
        .where(eq(resources.id, params.resourceId))
        .limit(1);

    const match = row?.icon ? DATA_URL.exec(row.icon) : null;

    if (!match?.[1] || match[3] === undefined) error(404);

    const [, type, base64, data] = match;

    if (!type.startsWith("image/")) error(404);

    const body = base64 ? Buffer.from(data, "base64") : Buffer.from(decodeURIComponent(data));

    return new Response(body, {
        headers: {
            "content-type": type,
            "cache-control": "private, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
            // An SVG opened on its own runs as a page on this origin; never let it script.
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
    });
};
