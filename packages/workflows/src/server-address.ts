import { isAllowedS3Address } from "@stoat/s3/client";
import { BlockList, isIP } from "node:net";

const privateNetworks = new BlockList();

// RFC 1918, the carrier-grade NAT range Tailscale hands out addresses from, and IPv6 unique local
// addresses (Tailscale's fd7a:115c:a1e0::/48 included).
for (const [address, prefix, type] of [
    ["10.0.0.0", 8, "ipv4"],
    ["172.16.0.0", 12, "ipv4"],
    ["192.168.0.0", 16, "ipv4"],
    ["100.64.0.0", 10, "ipv4"],
    ["fc00::", 7, "ipv6"],
] satisfies [string, number, "ipv4" | "ipv6"][]) {
    privateNetworks.addSubnet(address, prefix, type);
}

const tailscale = new BlockList();

tailscale.addSubnet("100.64.0.0", 10);

/** Whether Stoat reaches this server over a private network (LAN or Tailscale) rather than the internet. */
export function isPrivateServerAddress(address: string) {
    const version = isIP(address);

    return version !== 0 && privateNetworks.check(address, version === 6 ? "ipv6" : "ipv4");
}

/** Same policy as S3 endpoints and Git hosts (loopback, link-local and metadata never), plus Tailscale. */
export function isAllowedServerAddress(address: string) {
    if (isAllowedS3Address(address)) return true;

    // Alibaba Cloud's metadata service sits in the carrier-grade NAT range too.
    return isIP(address) === 4 && address !== "100.100.100.200" && tailscale.check(address);
}
