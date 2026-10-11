import { describe, expect, it } from "vite-plus/test";
import { caddyComposeSpec, parseCaddyComposeSpec } from "../../packages/workflows/src/deploy-caddy";

describe("caddy deployment spec", () => {
    it("round-trips the image and a multi-line global Caddyfile", () => {
        const caddyfile = "{\n\temail ops@example.com\n}\n\n(headers) {\n\theader -Server\n}";
        const spec = caddyComposeSpec("ghcr.io/example/caddy:2.10", `\n${caddyfile}\n`);

        expect(spec).toContain("x-caddy: |");
        expect(parseCaddyComposeSpec(spec)).toEqual({
            image: "ghcr.io/example/caddy:2.10",
            caddyfile: `${caddyfile}\n`,
        });
    });

    it("omits x-caddy when the Caddyfile is blank", () => {
        const spec = caddyComposeSpec("caddy:2", "  \n");

        expect(spec).not.toContain("x-caddy");
        expect(parseCaddyComposeSpec(spec)).toEqual({ image: "caddy:2", caddyfile: "" });
    });

    it("rejects a spec without an image", () => {
        expect(() => parseCaddyComposeSpec("services:\n  caddy: {}\n")).toThrow();
    });
});
