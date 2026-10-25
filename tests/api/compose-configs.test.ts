import { describe, expect, it } from "vite-plus/test";
import YAML from "yaml";

import {
    addConfig,
    attachConfig,
    ComposeConfigError,
    composeConfigs,
    detachConfig,
    nextConfigName,
    removeConfig,
    setConfigContent,
    updateConfigMount,
} from "../../packages/api/src/compose-configs";
import { interpolateCompose } from "../../packages/workflows/src/compose";

const compose = `services:
  web:
    image: nginx
  db:
    image: postgres
`;

// The shape of a real stack: configs shared through a merged anchor.
const copyparty = `x-copyparty: &copyparty
  image: copyparty/ac:latest
  configs:
    - source: party_config
      target: /cfg/party.conf
      mode: 444
    - source: preparty_script
      target: /cfg/preparty.sh
      mode: 444

services:
  copyparty-luna:
    <<: *copyparty
    volumes:
      - copyparty_cfg_luna:/cfg
  copyparty-hazel:
    <<: *copyparty
    volumes:
      - copyparty_cfg_hazel:/cfg

configs:
  party_config:
    content: |
      [global]
        e2dsa
  preparty_script:
    file: ./preparty.sh

volumes:
  copyparty_cfg_hazel:
  copyparty_cfg_luna:
`;

const mountedBy = (text: string) =>
    composeConfigs(text).map(({ name, services }) => ({ name, services }));

describe("composeConfigs", () => {
    it("reads configs mounted through a merged anchor", () => {
        expect(composeConfigs(copyparty)).toEqual([
            {
                name: "party_config",
                content: "[global]\n  e2dsa\n",
                file: null,
                services: ["copyparty-luna", "copyparty-hazel"],
                mounts: [
                    { service: "copyparty-luna", target: "/cfg/party.conf", mode: "0674" },
                    { service: "copyparty-hazel", target: "/cfg/party.conf", mode: "0674" },
                ],
            },
            {
                name: "preparty_script",
                content: null,
                file: "./preparty.sh",
                services: ["copyparty-luna", "copyparty-hazel"],
                mounts: [
                    { service: "copyparty-luna", target: "/cfg/preparty.sh", mode: "0674" },
                    { service: "copyparty-hazel", target: "/cfg/preparty.sh", mode: "0674" },
                ],
            },
        ]);
    });
});

describe("composeConfigs with partial specs", () => {
    it("reads an empty `configs:` and leaves environment configs uneditable", () => {
        const spec = `services:
  web:
    image: nginx
    configs:
configs:
  token:
    environment: TOKEN
`;

        expect(composeConfigs(spec)).toEqual([
            { name: "token", content: null, file: null, services: [], mounts: [] },
        ]);
    });
});

describe("addConfig", () => {
    it("declares an empty inline config and mounts it with an explicit target", () => {
        const next = addConfig(compose, "nginx.conf", "web", "/etc/nginx/nginx.conf");

        expect(composeConfigs(next)).toEqual([
            {
                name: "nginx.conf",
                content: "",
                file: null,
                services: ["web"],
                mounts: [{ service: "web", target: "/etc/nginx/nginx.conf", mode: null }],
            },
        ]);
    });

    it("refuses a taken name, a missing service and a relative path", () => {
        const next = addConfig(compose, "app", "web", "/app.conf");

        expect(() => addConfig(next, "app", "db", "/app.conf")).toThrow(ComposeConfigError);
        expect(() => addConfig(compose, "app", "nope", "/app.conf")).toThrow(ComposeConfigError);
        expect(() => addConfig(compose, "app", "web", "app.conf")).toThrow(ComposeConfigError);
    });

    it("names configs after their file, numbered when taken", () => {
        expect(nextConfigName(compose, "/etc/nginx/nginx.conf")).toBe("nginx.conf");
        expect(nextConfigName(copyparty, "/cfg/party_config")).toBe("party_config-2");
    });
});

describe("attach and detach through a merged anchor", () => {
    it("detaching from one service leaves the other's mounts alone", () => {
        const next = detachConfig(copyparty, "party_config", "copyparty-luna");

        expect(mountedBy(next)).toEqual([
            { name: "party_config", services: ["copyparty-hazel"] },
            { name: "preparty_script", services: ["copyparty-luna", "copyparty-hazel"] },
        ]);
    });

    it("keeps an empty list over an inherited one when its only mount detaches", () => {
        const inherited = `x-base: &base
  configs: [app]
services:
  web:
    <<: *base
    image: nginx
configs:
  app:
    content: ""
`;

        expect(mountedBy(detachConfig(inherited, "app", "web"))).toEqual([
            { name: "app", services: [] },
        ]);

        const removed = removeConfig(inherited, "app");

        expect(YAML.parse(removed, { merge: true }).services.web.configs).toEqual([]);
    });

    it("keeps the config declared after its last service detaches", () => {
        const added = addConfig(compose, "app", "web", "/app.conf");

        expect(mountedBy(detachConfig(added, "app", "web"))).toEqual([
            { name: "app", services: [] },
        ]);
    });

    it("attaches a declared config to another service", () => {
        const added = addConfig(compose, "app", "web", "/app.conf");

        expect(mountedBy(attachConfig(added, "app", "db", "/etc/app.conf"))).toEqual([
            { name: "app", services: ["web", "db"] },
        ]);
        expect(() => attachConfig(added, "app", "web", "/x")).toThrow(ComposeConfigError);
        expect(() => attachConfig(added, "nope", "db", "/x")).toThrow(ComposeConfigError);
    });
});

describe("updateConfigMount", () => {
    it("writes the mode as a quoted octal string", () => {
        const added = addConfig(compose, "app", "web", "/app.conf");
        const next = updateConfigMount(added, "app", "web", "/etc/app.conf", "444");

        expect(next).toContain('mode: "0444"');
        expect(composeConfigs(next)[0]?.mounts).toEqual([
            { service: "web", target: "/etc/app.conf", mode: "0444" },
        ]);
        expect(() => updateConfigMount(added, "app", "web", "/x", "999")).toThrow(
            ComposeConfigError,
        );
    });
});

describe("setConfigContent and removeConfig", () => {
    it("writes content as a literal block that keeps `$$` for Compose to unescape", () => {
        const added = addConfig(compose, "app", "web", "/app.conf");

        const next = setConfigContent(
            added,
            "app",
            "proxy_set_header Host $$host;\nport ${PORT}\n",
        );

        expect(next).toContain("content: |");

        const resolved = YAML.parse(interpolateCompose(next, "PORT=8080"));

        expect(resolved.configs.app.content).toBe("proxy_set_header Host $$host;\nport 8080\n");
    });

    it("turns a file config into inline content", () => {
        const next = YAML.parse(setConfigContent(copyparty, "preparty_script", "echo hi\n"));

        expect(next.configs.preparty_script).toEqual({ content: "echo hi\n" });
    });

    it("unmounts a config from every service before deleting it", () => {
        const next = removeConfig(copyparty, "party_config");

        expect(mountedBy(next)).toEqual([
            { name: "preparty_script", services: ["copyparty-luna", "copyparty-hazel"] },
        ]);
    });
});
