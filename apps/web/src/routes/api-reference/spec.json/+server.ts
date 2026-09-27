import { OpenAPIGenerator } from "@orpc/openapi";
import { ValibotToJsonSchemaConverter } from "@orpc/valibot";
import { ZodToJsonSchemaConverter } from "@orpc/zod";
import { appRouter } from "@stoat/api/routers/index";
import { json, type RequestHandler } from "@sveltejs/kit";

const generator = new OpenAPIGenerator({
    converters: [new ZodToJsonSchemaConverter(), new ValibotToJsonSchemaConverter()],
});

export const GET: RequestHandler = async ({ url }) =>
    json(
        await generator.generate(appRouter, {
            version: "3.1.1",
            base: {
                info: { title: "Stoat API", version: "1.0.0" },
                servers: [{ url: `${url.origin}/rpc/api` }],
                security: [{ apiKey: [] }],
                components: {
                    securitySchemes: {
                        apiKey: { type: "apiKey", in: "header", name: "x-api-key" },
                    },
                },
            },
        }),
    );
