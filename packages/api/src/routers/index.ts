import type { RouterClient } from "@orpc/server";

import { protectedProcedure, publicProcedure } from "../index";

import { clusterRouter } from "./cluster";

import { projectsRouter } from "./projects";
import { resourcesRouter } from "./resources";
import { connectionsRouter } from "./connections";
import { bucketsRouter } from "./buckets";
import { s3Router } from "./s3";

const healthCheck = publicProcedure.handler(() => {
    return "OK";
});

const privateData = protectedProcedure.handler(({ context }) => {
    return {
        message: "This is private",
        user: context.session?.user,
    };
});

// Declared by reference: inferring the whole tree exceeds what tsc will serialize (TS7056).
export type AppRouter = {
    cluster: typeof clusterRouter;
    projects: typeof projectsRouter;
    resources: typeof resourcesRouter;
    connections: typeof connectionsRouter;
    s3: typeof s3Router;
    buckets: typeof bucketsRouter;
    healthCheck: typeof healthCheck;
    privateData: typeof privateData;
};

export const appRouter: AppRouter = {
    cluster: clusterRouter,
    projects: projectsRouter,
    resources: resourcesRouter,
    connections: connectionsRouter,
    s3: s3Router,
    buckets: bucketsRouter,
    healthCheck,
    privateData,
};

export type AppRouterClient = RouterClient<AppRouter>;
