import { s3ProviderIcons } from "$lib/components/s3/provider-icon.svelte";
import Box from "@lucide/svelte/icons/box";
import Container from "@lucide/svelte/icons/container";
import Database from "@lucide/svelte/icons/database";
import FileCog from "@lucide/svelte/icons/file-cog";
import GitBranch from "@lucide/svelte/icons/git-branch";
import HardDrive from "@lucide/svelte/icons/hard-drive";
import Layers from "@lucide/svelte/icons/layers";
import Settings from "@lucide/svelte/icons/settings";
import SquareTerminal from "@lucide/svelte/icons/square-terminal";
import { dockerHubLogoUrl, dockerHubRepository } from "@stoat/api/docker-hub";
import type { AppRouterClient } from "@stoat/api/routers/index";
import { s3Providers } from "@stoat/s3/providers";
import type { Component } from "svelte";

import type { VolumeTarget } from "../graph";
import { imageCompose, imageServiceName, isImageReference } from "./docker-image";

export const addPages = [
    "root",
    "git",
    "database",
    "template",
    "docker",
    "bucket",
    "volume",
    "config",
] as const;

export type AddPage = (typeof addPages)[number];

export type CreateInput = Omit<
    Parameters<AppRouterClient["resources"]["createResource"]>[0],
    "projectId"
>;

export type Template = Awaited<ReturnType<AppRouterClient["resources"]["listTemplates"]>>[number];

type GitConnection = Awaited<
    ReturnType<AppRouterClient["connections"]["list"]>
>["connections"][number];

type Repository = Awaited<
    ReturnType<AppRouterClient["connections"]["getRepositories"]>
>["repositories"][number];

type S3Connection = Awaited<ReturnType<AppRouterClient["s3"]["list"]>>[number];

type DockerHubResult = Awaited<
    ReturnType<AppRouterClient["resources"]["searchDockerImages"]>
>[number];

export type Entry = {
    id: string;
    label: string;
    description: string | undefined;
    logo: string | null;
    icon: Component;
    /** A Git provider's logo instead of `icon`. */
    provider: string | undefined;
    /** A palette sub-page, a page to open, or a resource to add to the canvas. */
    target:
        | { page: AddPage }
        | { href: string }
        | { create: CreateInput }
        | { template: Template }
        | { bucket: { connectionId: string } }
        | { volumeService: VolumeTarget };
};

export const pageTitles: Record<AddPage, string> = {
    root: "",
    git: "Git Repository",
    database: "Database",
    template: "Template",
    docker: "Docker Image",
    bucket: "Bucket",
    volume: "Volume",
    config: "Config",
};

export const pagePlaceholders: Record<AddPage, string> = {
    root: "What would you like to create?",
    git: "Search repositories...",
    database: "Choose a database...",
    template: "Search templates...",
    docker: "traefik/whoami",
    bucket: "Choose an S3 connection...",
    volume: "Service to attach volume to",
    config: "Service to attach config to",
};

export function volumeTargetKey(target: VolumeTarget) {
    return `${target.resourceId}:${target.service}`;
}

function pageEntry(id: AddPage, label: string, icon: Component): Entry {
    return {
        id,
        label,
        description: undefined,
        logo: null,
        icon,
        provider: undefined,
        target: { page: id },
    };
}

/** The first page. Volumes and configs need a service to attach to; buckets need an admin. */
export function rootEntries(hasVolumeTargets: boolean, isAdmin: boolean): Entry[] {
    return [
        pageEntry("git", "Git Repository", GitBranch),
        pageEntry("database", "Database", Database),
        pageEntry("template", "Template", Layers),
        pageEntry("docker", "Docker Image", Container),
        ...(hasVolumeTargets
            ? [pageEntry("volume", "Volume", HardDrive), pageEntry("config", "Config", FileCog)]
            : []),
        ...(isAdmin ? [pageEntry("bucket", "Bucket", HardDrive)] : []),
        {
            id: "empty",
            label: "Empty Service",
            description: undefined,
            logo: null,
            icon: SquareTerminal,
            provider: undefined,
            target: { create: { name: "Empty Service" } },
        },
    ];
}

/** Databases on the database page, every other template on the template page. */
export function templateEntries(templates: Template[], databases: boolean): Entry[] {
    return templates.flatMap((template): Entry[] =>
        (template.type === "database") === databases
            ? [
                  {
                      id: template.appId,
                      label: template.name,
                      description: databases ? undefined : template.description,
                      logo: template.logo,
                      icon: Box,
                      provider: undefined,
                      target: { template },
                  },
              ]
            : [],
    );
}

/** Railway lists every repository it can reach; here that is every connection's. */
export function gitEntries(
    createHref: string,
    connections: { connection: GitConnection; repositories: Repository[] }[],
): Entry[] {
    return [
        {
            id: "configure",
            label: "Configure Git Connections",
            description: undefined,
            logo: null,
            icon: Settings,
            provider: undefined,
            target: { href: "/git" },
        },
        ...connections.flatMap(({ connection, repositories }) =>
            repositories.map((repository): Entry => ({
                id: `${connection.id}/${repository.url}`,
                label: repository.name,
                description: connection.name,
                logo: null,
                icon: GitBranch,
                provider: connection.provider,
                // Without a known default branch, the create page asks for one. Quick creation
                // reads the root; without a Compose file there, it falls back to that page too.
                target: repository.defaultBranch
                    ? {
                          create: {
                              name: repository.name.split("/").at(-1) ?? repository.name,
                              git: {
                                  connectionId: connection.id,
                                  repositoryUrl: repository.url,
                                  branch: repository.defaultBranch,
                                  path: ".",
                              },
                          },
                      }
                    : {
                          href: `${createHref}/git?${new URLSearchParams({
                              connectionId: connection.id,
                              repositoryUrl: repository.url,
                          })}`,
                      },
            })),
        ),
    ];
}

export function bucketEntries(connections: S3Connection[]): Entry[] {
    return [
        ...connections.map((connection): Entry => ({
            id: connection.id,
            label: connection.name,
            description: s3Providers[connection.provider].name,
            logo: s3ProviderIcons[connection.provider],
            icon: HardDrive,
            provider: undefined,
            target: { bucket: { connectionId: connection.id } },
        })),
        {
            id: "configure",
            label: "Configure S3 Connections",
            description: undefined,
            logo: null,
            icon: Settings,
            provider: undefined,
            // Without a connection there is nothing to pick, so go straight to adding one.
            target: {
                href: connections.length === 0 ? "/s3?dialog=create-connection" : "/s3",
            },
        },
    ];
}

export function volumeEntries(targets: VolumeTarget[]): Entry[] {
    return targets.map((target) => ({
        id: volumeTargetKey(target),
        label: target.label,
        description: undefined,
        logo: target.icon,
        icon: Box,
        provider: undefined,
        target: { volumeService: target },
    }));
}

function imageEntry(
    reference: string,
    description: string | undefined,
    logo: string | null,
): Entry {
    return {
        id: `image:${reference}`,
        label: reference,
        description,
        logo,
        icon: Container,
        provider: undefined,
        target: {
            create: {
                name: imageServiceName(reference),
                compose: imageCompose(reference),
                logoImage: reference,
            },
        },
    };
}

/** Docker Hub's `library/postgres` is searched as `postgres`; other registries aren't searched. */
export function dockerHubSearchTerm(image: string) {
    return isImageReference(image) ? dockerHubRepository(image) : null;
}

/** What was typed comes first, then Docker Hub's other matches. */
export function dockerEntries(image: string, results: DockerHubResult[]): Entry[] {
    if (!isImageReference(image)) return [];

    const repository = dockerHubRepository(image);

    return [
        imageEntry(image, undefined, repository ? dockerHubLogoUrl(repository) : null),
        ...(repository ? results : []).flatMap((result) =>
            dockerHubRepository(result.image) === repository
                ? []
                : [imageEntry(result.image, result.description ?? undefined, result.logo)],
        ),
    ];
}

export function templateInput(template: Template, variables: Record<string, string>): CreateInput {
    return {
        name: template.name,
        template: {
            appId: template.appId,
            version: template.versions[0]?.version ?? "",
            variables,
        },
    };
}
