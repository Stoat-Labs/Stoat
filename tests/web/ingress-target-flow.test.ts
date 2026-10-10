import { expect, it } from "vite-plus/test";
import { render } from "svelte/server";
import IngressTargetFlow from "../../apps/web/src/lib/components/shared/ingress-target-flow.svelte";

it("converges every root-only hostname on a single upstream node", () => {
    const { body } = render(IngressTargetFlow, {
        props: {
            hosts: ["infrastructure.wtf", "status.bastos.cc", "uptime.irazz.lol"],
            service: "uk-dash",
            port: 3000,
        },
    });

    expect(body).toContain("infrastructure.wtf");
    expect(body).toContain("status.bastos.cc");
    expect(body).toContain("uptime.irazz.lol");
    expect(body.match(/uk-dash:3000/g)).toHaveLength(1);
    expect(body).not.toMatch(/>\s*\/\s*</);
});
