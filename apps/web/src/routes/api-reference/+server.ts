import type { RequestHandler } from "@sveltejs/kit";

const html = `<!doctype html>
<html>
    <head>
        <title>Stoat API Reference</title>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
    </head>
    <body>
        <div id="app"></div>
        <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
        <script>
            Scalar.createApiReference("#app", { url: "/api-reference/spec.json" });
        </script>
    </body>
</html>`;

export const GET: RequestHandler = () =>
    new Response(html, { headers: { "Content-Type": "text/html" } });
