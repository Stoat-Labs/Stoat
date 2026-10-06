import { describe, expect, it } from "vite-plus/test";

import {
    addIngressToCompose,
    bindError,
    buildHostSpec,
    buildHttpSpec,
    decomposePortSpec,
    hostnameError,
    interpolateComposeVariables,
    isCaddyFileRef,
    listComposeServices,
    parseCaddyRoutes,
    parseEnvText,
    parseIngressCompose,
    portTextError,
    removeIngressFromCompose,
    removeServiceCaddy,
    setServiceCaddy,
    specError,
} from "../../packages/workflows/src/ingress";

const composeWith = (body: string): string => `services:\n${body}`;

describe("parseIngressCompose services", () => {
    it("returns empty entries for a compose file without ingress", () => {
        expect(parseIngressCompose("services:\n  web:\n    image: nginx\n")).toEqual({
            services: ["web"],
            entries: [],
            caddyRoutes: [],
            issues: [],
        });
    });

    it("throws on invalid YAML and on a missing services map", () => {
        expect(() => parseIngressCompose("services: [")).toThrow("Invalid compose YAML");
        expect(() => parseIngressCompose("version: '3'\n")).toThrow(
            'Compose must contain a "services" map',
        );
        expect(() => parseIngressCompose("")).toThrow('Compose must contain a "services" map');
    });

    it("skips null service bodies but flags scalar ones", () => {
        const snapshot = parseIngressCompose("services:\n  empty:\n  scalar: just-a-string\n");

        expect(snapshot.services).toEqual(["empty", "scalar"]);
        expect(snapshot.entries).toEqual([]);
        expect(snapshot.issues).toHaveLength(1);
        expect(snapshot.issues[0]?.service).toBe("scalar");
    });

    it("lists services in file order", () => {
        expect(
            listComposeServices("services:\n  zed:\n    image: x\n  abc:\n    image: x\n"),
        ).toEqual(["zed", "abc"]);
    });

    it("resolves x-ports merged through YAML anchors", () => {
        const snapshot = parseIngressCompose(
            "x-base: &base\n  x-ports:\n    - example.com:8000/https\nservices:\n  web:\n    image: nginx\n    <<: *base\n",
        );

        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({
            kind: "http",
            service: "web",
            hostname: "example.com",
            containerPort: 8000,
        });
    });
});

describe("parseIngressCompose http entries", () => {
    it("parses bare ports with the https default", () => {
        const snapshot = parseIngressCompose(
            composeWith("  web:\n    image: x\n    x-ports:\n      - 8000\n"),
        );

        expect(snapshot.entries).toEqual([
            {
                kind: "http",
                service: "web",
                hostname: null,
                containerPort: 8000,
                protocol: "https",
                raw: "8000",
            },
        ]);
    });

    it("parses hostname, port, and protocol variants", () => {
        const snapshot = parseIngressCompose(
            composeWith(
                "  web:\n    image: x\n    x-ports:\n      - example.com:8000/https\n      - www.example.com:8080/http\n      - 9000/http\n      - api.domain.tld:9000/https\n",
            ),
        );

        expect(snapshot.entries).toHaveLength(4);
        expect(snapshot.entries[1]).toMatchObject({
            hostname: "www.example.com",
            containerPort: 8080,
            protocol: "http",
        });
        expect(snapshot.entries[2]).toMatchObject({ hostname: null, containerPort: 9000 });
    });

    it("accepts wildcard hostnames and numeric entries", () => {
        const snapshot = parseIngressCompose(
            "services:\n  web:\n    image: x\n    x-ports:\n      - '*.example.com:8000/https'\n      - 3000\n",
        );

        expect(snapshot.entries).toHaveLength(2);
        expect(snapshot.entries[0]).toMatchObject({ hostname: "*.example.com" });
        expect(snapshot.entries[1]).toMatchObject({ hostname: null, containerPort: 3000 });
    });

    it("normalizes uppercase protocols", () => {
        const snapshot = parseIngressCompose(
            composeWith("  web:\n    image: x\n    x-ports:\n      - example.com:8000/HTTPS\n"),
        );

        expect(snapshot.entries[0]).toMatchObject({ protocol: "https" });
    });

    it("rejects bad ports, protocols, and hostnames as issues", () => {
        const snapshot = parseIngressCompose(
            composeWith(
                "  web:\n    image: x\n    x-ports:\n      - 0/https\n      - 65536/https\n      - abc/https\n      - example.com:8000/tcp\n      - example.com:8000/banana\n      - 'bad_host!:8000/https'\n      - ':8000/https'\n      - example.com:8000/https/extra\n      - ''\n      - true\n",
            ),
        );

        expect(snapshot.entries).toEqual([]);
        expect(snapshot.issues).toHaveLength(10);
    });

    it("flags duplicate hostnames case-insensitively", () => {
        const snapshot = parseIngressCompose(
            composeWith(
                "  a:\n    image: x\n    x-ports:\n      - Example.com:8000/https\n  b:\n    image: x\n    x-ports:\n      - example.com:9000/https\n",
            ),
        );

        expect(snapshot.entries).toHaveLength(2);
        expect(snapshot.issues.some((issue) => issue.message.includes("more than once"))).toBe(
            true,
        );
    });

    it("flags a non-list x-ports value", () => {
        const snapshot = parseIngressCompose(
            composeWith("  web:\n    image: x\n    x-ports: example.com:8000/https\n"),
        );

        expect(snapshot.entries).toEqual([]);
        expect(snapshot.issues).toHaveLength(1);
    });
});

describe("parseIngressCompose host entries", () => {
    it("parses tcp and udp host bindings with defaults", () => {
        const snapshot = parseIngressCompose(
            composeWith(
                "  db:\n    image: x\n    x-ports:\n      - 127.0.0.1:5432:5432@host\n      - 53:5353/udp@host\n      - 8080:80@host\n",
            ),
        );

        expect(snapshot.entries).toEqual([
            {
                kind: "host",
                service: "db",
                bind: "127.0.0.1",
                hostPort: 5432,
                containerPort: 5432,
                protocol: "tcp",
                raw: "127.0.0.1:5432:5432@host",
            },
            {
                kind: "host",
                service: "db",
                bind: null,
                hostPort: 53,
                containerPort: 5353,
                protocol: "udp",
                raw: "53:5353/udp@host",
            },
            {
                kind: "host",
                service: "db",
                bind: null,
                hostPort: 8080,
                containerPort: 80,
                protocol: "tcp",
                raw: "8080:80@host",
            },
        ]);
    });

    it("accepts CIDR binds", () => {
        const snapshot = parseIngressCompose(
            composeWith(
                "  db:\n    image: x\n    x-ports:\n      - 192.168.76.0/24:5432:5432/tcp@host\n",
            ),
        );

        expect(snapshot.entries[0]).toMatchObject({ bind: "192.168.76.0/24" });
    });

    it("rejects http protocols, missing ports, and bad binds as issues", () => {
        const snapshot = parseIngressCompose(
            composeWith(
                "  db:\n    image: x\n    x-ports:\n      - 5432:5432/http@host\n      - 5432@host\n      - 999.1.1.1:5432:5432@host\n      - 192.168.1.0/33:5432:5432@host\n      - 0:5432@host\n",
            ),
        );

        expect(snapshot.entries).toEqual([]);
        expect(snapshot.issues).toHaveLength(5);
    });
});

describe("parseIngressCompose x-caddy", () => {
    it("keeps inline Caddyfiles verbatim", () => {
        const caddy = "example.com {\n  reverse_proxy {{upstreams 8000}}\n}\n";

        const snapshot = parseIngressCompose(
            `services:\n  web:\n    image: x\n    x-caddy: |\n      example.com {\n        reverse_proxy {{upstreams 8000}}\n      }\n`,
        );

        expect(snapshot.entries).toEqual([
            { kind: "caddy", service: "web", caddy, fileRef: false },
        ]);
        expect(snapshot.issues).toEqual([]);
    });

    it("marks file references and coexisting http ports", () => {
        const snapshot = parseIngressCompose(
            composeWith(
                "  web:\n    image: x\n    x-caddy: ./Caddyfile\n    x-ports:\n      - example.com:8000/https\n",
            ),
        );

        expect(snapshot.entries[1]).toMatchObject({ kind: "caddy", fileRef: true });
        expect(snapshot.issues.some((issue) => issue.message.includes("cannot also publish"))).toBe(
            true,
        );
    });

    it("allows host-mode ports next to x-caddy", () => {
        const snapshot = parseIngressCompose(
            composeWith(
                "  web:\n    image: x\n    x-caddy: |\n      example.com {\n        reverse_proxy {{upstreams 8000}}\n      }\n    x-ports:\n      - 5432:5432@host\n",
            ),
        );

        expect(snapshot.issues).toEqual([]);
        expect(snapshot.entries).toHaveLength(2);
    });

    it("rejects empty and non-string x-caddy values", () => {
        const snapshot = parseIngressCompose(
            composeWith(
                "  a:\n    image: x\n    x-caddy: '   '\n  b:\n    image: x\n    x-caddy:\n      upstream: web\n",
            ),
        );

        expect(snapshot.entries).toEqual([]);
        expect(snapshot.issues).toHaveLength(2);
    });
});

describe("parseCaddyRoutes", () => {
    const SEAFILE_CADDY = `files.example.com {
  handle_path /socket.io/* {
    rewrite * /socket.io{uri}
    reverse_proxy {{upstreams "seadoc" 80}}
  }
  handle_path /sdoc-server/* {
    rewrite * {uri}
    reverse_proxy {{upstreams "seadoc" 80}}
  }
  reverse_proxy {{upstreams 80}}
}
`;

    it("extracts one route per path handler plus the catch-all", () => {
        expect(parseCaddyRoutes(SEAFILE_CADDY, "seafile")).toEqual([
            {
                containerPort: 80,
                host: "files.example.com",
                path: "/socket.io/*",
                protocol: "https",
                serviceName: "seafile",
                upstreamService: "seadoc",
            },
            {
                containerPort: 80,
                host: "files.example.com",
                path: "/sdoc-server/*",
                protocol: "https",
                serviceName: "seafile",
                upstreamService: "seadoc",
            },
            {
                containerPort: 80,
                host: "files.example.com",
                protocol: "https",
                serviceName: "seafile",
                upstreamService: "seafile",
            },
        ]);
    });

    it("dedupes identical routes across handlers", () => {
        const caddy = `app.example.com {
  handle /a/* {
    reverse_proxy {{upstreams 80}}
  }
  handle /a/* {
    reverse_proxy {{upstreams 80}}
  }
}
`;

        expect(parseCaddyRoutes(caddy, "app")).toHaveLength(1);
    });

    it("respects explicit http scheme and port 80 addresses", () => {
        const caddy = `http://plain.example.com {
  reverse_proxy {{upstreams 3000}}
}

other.example.com:80 {
  reverse_proxy {{upstreams "backend" 8080}}
}
`;

        expect(parseCaddyRoutes(caddy, "web")).toEqual([
            {
                containerPort: 3000,
                host: "plain.example.com",
                protocol: "http",
                serviceName: "web",
                upstreamService: "web",
            },
            {
                containerPort: 8080,
                host: "other.example.com",
                protocol: "http",
                serviceName: "web",
                upstreamService: "backend",
            },
        ]);
    });

    it("strips quotes from path matchers", () => {
        const caddy = `app.example.com {
  handle_path "/x/*" {
    reverse_proxy {{upstreams 80}}
  }
  handle '/y/*' {
    reverse_proxy {{upstreams 81}}
  }
}
`;

        expect(parseCaddyRoutes(caddy, "app")).toEqual([
            {
                containerPort: 80,
                host: "app.example.com",
                path: "/x/*",
                protocol: "https",
                serviceName: "app",
                upstreamService: "app",
            },
            {
                containerPort: 81,
                host: "app.example.com",
                path: "/y/*",
                protocol: "https",
                serviceName: "app",
                upstreamService: "app",
            },
        ]);
    });

    it("handles upstreams without an explicit port", () => {
        const caddy = `app.example.com {
  reverse_proxy {{upstreams}}
}
`;

        expect(parseCaddyRoutes(caddy, "app")).toEqual([
            {
                host: "app.example.com",
                protocol: "https",
                serviceName: "app",
                upstreamService: "app",
            },
        ]);
    });

    it("skips snippet definitions and global blocks but keeps served hosts", () => {
        const caddy = `(common_proxy) {
  lb_retries 3
}

www.example.com {
  redir https://example.com{uri} permanent
}
`;

        expect(parseCaddyRoutes(caddy, "web")).toEqual([
            {
                host: "www.example.com",
                protocol: "https",
                serviceName: "web",
                upstreamService: "web",
            },
        ]);
    });

    it("collects routes into the compose snapshot", () => {
        const snapshot = parseIngressCompose(
            "services:\n  web:\n    image: x\n    x-caddy: |\n      web.example.com {\n        reverse_proxy {{upstreams 80}}\n      }\n",
        );

        expect(snapshot.caddyRoutes).toEqual([
            {
                containerPort: 80,
                host: "web.example.com",
                protocol: "https",
                serviceName: "web",
                upstreamService: "web",
            },
        ]);
    });
});

describe("environment variables", () => {
    const env = "SEAFILE_HOST=files.example.com\nPORT=8000\nEMPTY=\n";

    it("parses .env text", () => {
        const vars = parseEnvText(
            "# comment\n\nexport QUOTED=\"spaced value\" # trailing\nSINGLE='q'\nEMPTY=\nINVALID-LINE\nno-equals\n",
        );

        expect(vars.get("QUOTED")).toBe("spaced value");
        expect(vars.get("SINGLE")).toBe("q");
        expect(vars.get("EMPTY")).toBe("");
        expect(vars.has("INVALID-LINE")).toBe(false);
        expect(vars.has("no-equals")).toBe(false);
    });

    it("interpolates plain, braced, default, and required forms", () => {
        const lookup = (name: string): string | undefined => parseEnvText(env).get(name);

        expect(interpolateComposeVariables("$SEAFILE_HOST", lookup)).toBe("files.example.com");
        expect(interpolateComposeVariables("${SEAFILE_HOST}", lookup)).toBe("files.example.com");
        expect(interpolateComposeVariables("${MISSING:-fallback}", lookup)).toBe("fallback");
        expect(interpolateComposeVariables("${MISSING}", lookup)).toBe("");
        expect(interpolateComposeVariables("${MISSING:?boom}", lookup)).toBe("");
        expect(interpolateComposeVariables("$$SEAFILE_HOST", lookup)).toBe("$SEAFILE_HOST");
        expect(interpolateComposeVariables("a${EMPTY:-b}c", lookup)).toBe("abc");
    });

    it("resolves x-ports hostnames and ports from variables, keeping raw specs", () => {
        const snapshot = parseIngressCompose(
            "services:\n  web:\n    image: x\n    x-ports:\n      - ${SEAFILE_HOST}:${PORT}/https\n",
            env,
        );

        expect(snapshot.entries).toEqual([
            {
                kind: "http",
                service: "web",
                hostname: "files.example.com",
                containerPort: 8000,
                protocol: "https",
                raw: "${SEAFILE_HOST}:${PORT}/https",
            },
        ]);
        expect(snapshot.issues).toEqual([]);
    });

    it("resolves x-caddy site addresses from variables", () => {
        const snapshot = parseIngressCompose(
            "services:\n  web:\n    image: x\n    x-caddy: |\n      ${SEAFILE_HOST} {\n        reverse_proxy {{upstreams ${PORT}}}\n      }\n",
            env,
        );

        expect(snapshot.caddyRoutes).toEqual([
            {
                containerPort: 8000,
                host: "files.example.com",
                protocol: "https",
                serviceName: "web",
                upstreamService: "web",
            },
        ]);
    });

    it("skips addresses with unresolved variables instead of showing garbage", () => {
        const snapshot = parseIngressCompose(
            "services:\n  web:\n    image: x\n    x-caddy: |\n      ${MISSING_HOST} {\n        reverse_proxy {{upstreams 80}}\n      }\n",
            "",
        );

        expect(snapshot.caddyRoutes).toEqual([]);
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({ kind: "caddy" });
    });

    it("flags entries that stay invalid after interpolation", () => {
        const snapshot = parseIngressCompose(
            "services:\n  web:\n    image: x\n    x-ports:\n      - ${MISSING_PORT}/https\n",
            "",
        );

        expect(snapshot.entries).toEqual([]);
        expect(snapshot.issues).toHaveLength(1);
    });
});

describe("decomposePortSpec", () => {
    it("splits http specs into written parts", () => {
        expect(decomposePortSpec("example.com:8000/https")).toEqual({
            kind: "http",
            hostname: "example.com",
            portText: "8000",
            protocol: "https",
        });
        expect(decomposePortSpec("8000")).toEqual({
            kind: "http",
            hostname: null,
            portText: "8000",
            protocol: "https",
        });
        expect(decomposePortSpec("${HOST}:${PORT}/https")).toEqual({
            kind: "http",
            hostname: "${HOST}",
            portText: "${PORT}",
            protocol: "https",
        });
    });

    it("splits host specs into written parts", () => {
        expect(decomposePortSpec("127.0.0.1:5432:5432@host")).toEqual({
            kind: "host",
            bind: "127.0.0.1",
            hostPortText: "5432",
            containerPortText: "5432",
            protocol: "tcp",
        });
        expect(decomposePortSpec("53:5353/udp@host")).toEqual({
            kind: "host",
            bind: null,
            hostPortText: "53",
            containerPortText: "5353",
            protocol: "udp",
        });
    });

    it("returns null for blank and shapeless specs", () => {
        expect(decomposePortSpec("   ")).toBeNull();
        expect(decomposePortSpec("5432@host")).toBeNull();
        expect(decomposePortSpec("a:b:c/d")).toBeNull();
    });
});

describe("validators", () => {
    it("validates hostnames", () => {
        expect(hostnameError("example.com")).toBeNull();
        expect(hostnameError("*.example.com")).toBeNull();
        expect(hostnameError("localhost")).toBeNull();
        expect(hostnameError("example.com.")).toBeNull();
        expect(hostnameError("")).not.toBeNull();
        expect(hostnameError("*.")).not.toBeNull();
        expect(hostnameError("bad_host")).not.toBeNull();
        expect(hostnameError("a..b")).not.toBeNull();
        expect(hostnameError("-lead.com")).not.toBeNull();
        expect(hostnameError(`${"a".repeat(64)}.com`)).not.toBeNull();
        expect(hostnameError(`${"a".repeat(250)}.com`)).not.toBeNull();
    });

    it("validates port text", () => {
        expect(portTextError("8000")).toBeNull();
        expect(portTextError("1")).toBeNull();
        expect(portTextError("65535")).toBeNull();
        expect(portTextError("0")).not.toBeNull();
        expect(portTextError("65536")).not.toBeNull();
        expect(portTextError("-1")).not.toBeNull();
        expect(portTextError("80.5")).not.toBeNull();
        expect(portTextError("abc")).not.toBeNull();
        expect(portTextError("")).not.toBeNull();
    });

    it("validates bind addresses", () => {
        expect(bindError("")).toBeNull();
        expect(bindError("127.0.0.1")).toBeNull();
        expect(bindError("192.168.76.0/24")).toBeNull();
        expect(bindError("::1")).toBeNull();
        expect(bindError("999.1.1.1")).not.toBeNull();
        expect(bindError("192.168.1.0/33")).not.toBeNull();
        expect(bindError("nope")).not.toBeNull();
    });

    it("validates raw specs", () => {
        expect(specError("example.com:8000/https")).toBeNull();
        expect(specError("8000")).toBeNull();
        expect(specError("127.0.0.1:5432:5432@host")).toBeNull();
        expect(specError("")).not.toBeNull();
        expect(specError("example.com:8000/tcp")).not.toBeNull();
        expect(specError("99999")).not.toBeNull();
        expect(specError("5432@host")).not.toBeNull();
    });

    it("detects Caddyfile references", () => {
        expect(isCaddyFileRef("./Caddyfile")).toBe(true);
        expect(isCaddyFileRef("Caddyfile")).toBe(true);
        expect(isCaddyFileRef("/etc/caddy/Caddyfile")).toBe(true);
        expect(isCaddyFileRef("example.com {\n  reverse_proxy x\n}")).toBe(false);
        expect(isCaddyFileRef("example.com { reverse_proxy x }")).toBe(false);
        expect(isCaddyFileRef("")).toBe(false);
    });

    it("builds canonical specs", () => {
        expect(buildHttpSpec("example.com", 8000, "https")).toBe("example.com:8000/https");
        expect(buildHttpSpec(null, 3000, "http")).toBe("3000/http");
        expect(buildHostSpec("127.0.0.1", 5432, 5432, "tcp")).toBe("127.0.0.1:5432:5432/tcp@host");
        expect(buildHostSpec(null, 53, 5353, "udp")).toBe("53:5353/udp@host");
    });
});

describe("compose editing", () => {
    const base = "services:\n  web:\n    image: nginx\n";

    it("adds entries and preserves comments", () => {
        const next = addIngressToCompose(
            "# leading\nservices:\n  web: # trailing\n    image: nginx # pinned\n",
            "web",
            "example.com:8000/https",
        );

        expect(next).toContain("# leading");
        expect(next).toContain("# trailing");
        expect(next).toContain("# pinned");
        expect(next).toContain("- example.com:8000/https");
        expect(parseIngressCompose(next).entries).toHaveLength(1);
    });

    it("rejects duplicates, blanks, and unknown services", () => {
        const withOne = addIngressToCompose(base, "web", "example.com:8000/https");

        expect(() => addIngressToCompose(withOne, "web", "example.com:8000/https")).toThrow(
            "already exists",
        );
        expect(() => addIngressToCompose(base, "web", "   ")).toThrow("must not be empty");
        expect(() => addIngressToCompose(base, "ghost", "example.com:8000/https")).toThrow(
            'Service "ghost" not found',
        );
        expect(() =>
            addIngressToCompose("services:\n  web: just-a-string\n", "web", "8000"),
        ).toThrow("no configuration mapping");
        expect(() =>
            addIngressToCompose(
                "services:\n  web:\n    image: x\n    x-ports: nope\n",
                "web",
                "8000",
            ),
        ).toThrow("invalid x-ports");
    });

    it("removes entries and drops the key when empty", () => {
        const withTwo = addIngressToCompose(
            addIngressToCompose(base, "web", "example.com:8000/https"),
            "web",
            "8080:80@host",
        );

        const withOne = removeIngressFromCompose(withTwo, "web", "example.com:8000/https");

        expect(withOne).toContain("8080:80@host");
        expect(withOne).not.toContain("example.com");

        const cleared = removeIngressFromCompose(withOne, "web", "8080:80@host");

        expect(cleared).not.toContain("x-ports");
        expect(() => removeIngressFromCompose(cleared, "web", "8080:80@host")).toThrow(
            "no publish entries",
        );
    });

    it("sets and removes x-caddy as a block scalar", () => {
        const caddy = "example.com {\n  reverse_proxy {{upstreams 8000}}\n}";
        const next = setServiceCaddy(base, "web", caddy);

        expect(next).toContain("x-caddy: |");
        expect(next).toContain("reverse_proxy {{upstreams 8000}}");
        expect(parseIngressCompose(next).entries[0]).toMatchObject({
            kind: "caddy",
            fileRef: false,
        });

        const cleared = removeServiceCaddy(next, "web");

        expect(cleared).not.toContain("x-caddy");
        expect(() => removeServiceCaddy(cleared, "web")).toThrow("no x-caddy");
        expect(() => setServiceCaddy(base, "web", "   ")).toThrow("must not be empty");
        expect(() => setServiceCaddy(base, "ghost", caddy)).toThrow('Service "ghost" not found');
    });

    it("round-trips add then remove without touching other services", () => {
        const multi = "services:\n  web:\n    image: x\n  api:\n    image: y\n";
        const added = addIngressToCompose(multi, "api", "api.example.com:9000/https");
        const snapshot = parseIngressCompose(added);

        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({ service: "api" });

        const removed = removeIngressFromCompose(added, "api", "api.example.com:9000/https");

        expect(parseIngressCompose(removed).entries).toEqual([]);
        expect(removed).toContain("web:");
        expect(removed).toContain("api:");
    });
});
