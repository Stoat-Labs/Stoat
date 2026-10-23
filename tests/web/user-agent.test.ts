import { expect, it } from "vite-plus/test";
import { describeUserAgent } from "../../apps/web/src/lib/user-agent";

it("names the browser and system", () => {
    expect(
        describeUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0"),
    ).toBe("Firefox on Linux");
    expect(
        describeUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0",
        ),
    ).toBe("Edge on Windows");
    expect(
        describeUserAgent(
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        ),
    ).toBe("Safari on iOS");
    expect(
        describeUserAgent(
            "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36",
        ),
    ).toBe("Chrome on Android");
});

it("falls back for missing or unknown agents", () => {
    expect(describeUserAgent(null)).toBe("Unknown device");
    expect(describeUserAgent("curl/8.9.1")).toBe("Unknown device");
});
