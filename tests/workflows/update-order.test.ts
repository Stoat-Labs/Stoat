import { describe, expect, it } from "vite-plus/test";

import {
    serviceUpdateOrder,
    setServiceUpdateOrder,
} from "../../packages/workflows/src/update-order";

const compose = `services:
  db:
    image: mariadb:10.11
    # keep one replica
    deploy:
      replicas: 1
`;

const bare = `services:
  cache:
    image: redis
`;

describe("setServiceUpdateOrder", () => {
    it("adds the order under deploy.update_config, keeping comments and siblings", () => {
        const next = setServiceUpdateOrder(compose, "stop-first");

        expect(serviceUpdateOrder(next)).toBe("stop-first");
        expect(next).toContain("# keep one replica");
        expect(next).toContain(
            "    deploy:\n      replicas: 1\n      update_config:\n        order: stop-first\n",
        );
    });

    it("drops update_config and deploy once clearing leaves them empty", () => {
        const set = setServiceUpdateOrder(bare, "start-first");

        expect(setServiceUpdateOrder(set, null)).toBe(bare);
        expect(serviceUpdateOrder(bare)).toBeNull();
    });

    it("keeps deploy when it holds other keys", () => {
        const set = setServiceUpdateOrder(compose, "stop-first");

        expect(setServiceUpdateOrder(set, null)).toBe(compose);
    });

    it("rejects a Compose file without a service", () => {
        expect(() => setServiceUpdateOrder("services: {}\n", "stop-first")).toThrow(/no service/u);
    });
});
