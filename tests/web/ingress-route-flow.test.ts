import { expect, it } from "vite-plus/test";
import { render } from "svelte/server";
import IngressRouteFlow from "../../apps/web/src/lib/components/shared/ingress-route-flow.svelte";

it("renders one hostname and a distinct path-to-container branch for every route", () => {
    const { body } = render(IngressRouteFlow, {
        props: {
            host: "files.irazz.lol",
            items: [
                { key: "root", path: "/", service: "seafile-seafile", port: 80 },
                { key: "sdoc", path: "/sdoc-server/*", service: "seafile-seadoc", port: 80 },
                { key: "socket", path: "/socket.io/*", service: "seafile-seadoc", port: 80 },
            ],
        },
    });

    expect(body.match(/files\.irazz\.lol/g)).toHaveLength(1);
    expect(body).toContain("/sdoc-server/*");
    expect(body).toContain("/socket.io/*");
    expect(body).toContain("seafile-seafile:80");
    expect(body.match(/seafile-seadoc:80/g)).toHaveLength(2);
    expect(body.match(/:80/g)).toHaveLength(3);
    expect(body).not.toContain("Clients");
    expect(body).not.toContain("Caddy");
});
