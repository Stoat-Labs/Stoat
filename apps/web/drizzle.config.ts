import { defineConfig } from "drizzle-kit";

export default defineConfig({
    schema: [
        "./node_modules/@stoat/db/src/schema",
        "./node_modules/@stoat/workflows/src/schema.ts",
    ],
    out: "./node_modules/@stoat/db/src/migrations",
    dialect: "postgresql",
    dbCredentials: {
        url: process.env.DATABASE_URL ?? "",
    },
});
