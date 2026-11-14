import { ORPCError } from "@orpc/server";
import { clusters, projects, resourceGroups, resources } from "@clowder/db/schema/index";
import { resourceSlug } from "@clowder/db/slug";
import { ucClient, unwrap } from "@clowder/uncloud";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { organizationProcedure } from "../..";
import { moveComposeEnvironment } from "../../compose";
import {
    expandSecrets,
    fillVariables,
    linkCompanions,
    summarizeVersion,
    templates,
} from "../../templates";
import { gitSourceInput, loadGitCompose, validateCompose } from "./git";
import { gitText } from "../connections";
import { fetchDockerHubLogo, searchDockerHub } from "../../docker-hub";

export const resourceCreateRouter = {
    createResource: organizationProcedure
        .input(
            v.object({
                projectId: v.pipe(v.string(), v.uuid()),
                name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)),
                description: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(500))),
                type: v.optional(v.picklist(["compose"]), "compose"),
                git: v.optional(gitSourceInput),
                /** A starting Compose draft, e.g. one service running a Docker image. */
                compose: v.optional(gitText),
                /** A Docker image whose Docker Hub logo, if any, becomes the icon. */
                logoImage: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(512))),
                template: v.optional(
                    v.object({
                        appId: v.string(),
                        version: v.string(),
                        variables: v.optional(
                            v.record(
                                v.string(),
                                v.pipe(
                                    v.string(),
                                    v.trim(),
                                    v.regex(/^[^\r\n]*$/u, "Variables must be a single line."),
                                    v.check(
                                        (value) => !["'", '"', "`"].every((q) => value.includes(q)),
                                        "Variables can't mix all three quote characters.",
                                    ),
                                    v.maxLength(4096),
                                ),
                            ),
                            {},
                        ),
                    }),
                ),
            }),
        )
        .handler(async ({ context: { db, organizationId }, input }) => {
            const template = templates.find((t) => t.appId === input.template?.appId);
            const version = input.template && template?.versions[input.template.version];

            if (input.template && !version) {
                throw new ORPCError("NOT_FOUND", { message: "Template not found." });
            }

            const missing = version
                ? summarizeVersion(version).required.filter(
                      (key) => !input.template?.variables[key],
                  )
                : [];

            if (missing.length > 0) {
                throw new ORPCError("BAD_REQUEST", {
                    message: `Set the required variables: ${missing.join(", ")}.`,
                });
            }

            if ([input.template, input.git, input.compose].filter(Boolean).length > 1) {
                throw new ORPCError("BAD_REQUEST", {
                    message: "Choose one of a template, a Git source or a Compose file.",
                });
            }

            if (input.compose) validateCompose(input.compose);

            const [project] = await db
                .select({
                    id: projects.id,
                    sidecarUrl: clusters.sidecarUrl,
                    sidecarToken: clusters.sidecarToken,
                    sidecarCertificate: clusters.sidecarCertificate,
                })
                .from(projects)
                .innerJoin(clusters, eq(projects.clusterId, clusters.id))
                .where(
                    and(
                        eq(projects.id, input.projectId),
                        sql`${projects.isInternal} is not true`,
                        eq(clusters.organizationId, organizationId),
                    ),
                )
                .limit(1);

            if (!project) {
                throw new ORPCError("NOT_FOUND", { message: "Project not found." });
            }

            const domain =
                version &&
                /\{\{\s*DNS\s*\}\}/iu.test(
                    [version, ...Object.values(version.companions)]
                        .map(({ compose, env }) => compose + env)
                        .join(),
                )
                    ? await unwrap(
                          ucClient(project.sidecarUrl, {
                              token: project.sidecarToken,
                              certificate: project.sidecarCertificate,
                          }).GET("/api/v1/cluster/domain"),
                      ).then(
                          ({ domain }) => domain,
                          () => {
                              throw new ORPCError("BAD_REQUEST", {
                                  message:
                                      "This template needs the cluster's reserved domain, which is unavailable.",
                              });
                          },
                      )
                    : undefined;

            const description = input.description?.trim() ? input.description.trim() : null;
            const source = input.git ? await loadGitCompose(db, organizationId, input.git) : {};
            const pasted = input.compose ? moveComposeEnvironment(input.compose, "") : undefined;

            const icon =
                !template && input.logoImage ? await fetchDockerHubLogo(input.logoImage) : null;

            // Companions get their ids first so the app's `{{ key.NAME }}` references can name them.
            const companionIds = Object.fromEntries(
                Object.keys(template?.resources ?? {}).map((key) => [key, randomUUID()]),
            );

            const companions = Object.entries(template?.resources ?? {}).flatMap(
                ([key, { name, engine }]) => {
                    const files = version?.companions[key];
                    const id = companionIds[key];

                    return files && id
                        ? [
                              {
                                  id,
                                  name: `${input.name.trim()} ${name}`.slice(0, 100),
                                  slug: resourceSlug(`${input.name} ${name}`),
                                  type: engine ? ("database" as const) : ("compose" as const),
                                  // A database companion wears the bundled template's logo for its engine.
                                  icon: engine
                                      ? (templates.find(
                                            (entry) =>
                                                entry.type === "database" &&
                                                entry.engine === engine,
                                        )?.logo ?? null)
                                      : null,
                                  projectId: project.id,
                                  draftSpec: expandSecrets(files.compose, domain),
                                  settings: {
                                      ...(engine && { engine }),
                                      prefixNames: true,
                                      env: fillVariables(
                                          linkCompanions(
                                              expandSecrets(files.env, domain),
                                              companionIds,
                                          ),
                                          input.template?.variables ?? {},
                                      ),
                                  },
                              },
                          ]
                        : [];
                },
            );

            // Every template starts out in its own group, drawn with its companions on the canvas.
            const groupId = template ? randomUUID() : null;

            const created = await db.transaction(async (tx) => {
                if (groupId)
                    await tx.insert(resourceGroups).values({
                        id: groupId,
                        projectId: project.id,
                        name: input.name.trim(),
                        icon: template?.logo ?? null,
                    });

                return tx
                    .insert(resources)
                    .values([
                        {
                            groupId,
                            ...source,
                            ...(pasted && {
                                draftSpec: pasted.compose,
                                settings: { env: pasted.env },
                            }),
                            id: randomUUID(),
                            name: input.name.trim(),
                            slug: resourceSlug(input.name),
                            description,
                            icon,
                            type: template?.type ?? input.type,
                            projectId: project.id,
                            ...(template &&
                                version && {
                                    icon: template.logo,
                                    draftSpec: expandSecrets(version.compose, domain),
                                    settings: {
                                        ...(template.type === "database" && {
                                            engine: template.engine,
                                        }),
                                        prefixNames: true,
                                        env: fillVariables(
                                            linkCompanions(
                                                expandSecrets(version.env, domain),
                                                companionIds,
                                            ),
                                            input.template?.variables ?? {},
                                        ),
                                    },
                                }),
                        },
                        ...companions.map((companion) => ({ ...companion, groupId })),
                    ])
                    .returning();
            });

            return created[0];
        }),

    // The browser can't reach Docker Hub's search (no CORS), so the server asks for it.
    searchDockerImages: organizationProcedure
        .input(v.object({ query: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(100)) }))
        .handler(({ input }) => searchDockerHub(input.query, 8)),

    listTemplates: organizationProcedure.handler(() =>
        templates.map(({ versions, ...template }) => ({
            ...template,
            versions: Object.entries(versions)
                .map(([version, files]) => ({ version, ...summarizeVersion(files) }))
                // Integer-like keys ("18") lose insertion order, so sort newest first here.
                .toSorted((a, b) =>
                    b.version.localeCompare(a.version, undefined, { numeric: true }),
                ),
        })),
    ),
};
