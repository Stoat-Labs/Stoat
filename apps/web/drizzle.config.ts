import { defineConfig } from "drizzle-kit";

export default defineConfig({
    schema: [
        "./node_modules/@clowder/db/src/schema/index.ts",
        "./node_modules/@clowder/workflows/src/schema.ts",
    ],
    out: "./node_modules/@clowder/db/src/migrations",
    dialect: "postgresql",
    dbCredentials: {
        url: process.env.DATABASE_URL ?? "",
    },
});
