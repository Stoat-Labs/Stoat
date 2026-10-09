import { describe, expect, it } from "vite-plus/test";
import {
    deploymentDuration,
    elapsed,
    formatDurationMs,
    parseDateInput,
    toLocalDateInput,
} from "../../apps/web/src/lib/format";

describe("formatDurationMs", () => {
    it.each([
        [0, "0s"],
        [59_999, "59s"],
        [60_000, "1m 0s"],
        [3_599_000, "59m 59s"],
        [3_600_000, "1h 0m"],
        [90_061_000, "25h 1m"],
    ])("formats %ims as %s", (ms, expected) => {
        expect(formatDurationMs(ms)).toBe(expected);
    });

    it("clamps negative durations from clock skew to zero", () => {
        expect(formatDurationMs(-5_000)).toBe("0s");
    });
});

describe("deploymentDuration", () => {
    const createdAt = "2026-10-06T12:00:00.000Z";

    it("measures a finished deployment up to its finish time", () => {
        expect(deploymentDuration(createdAt, "2026-10-06T12:01:05.000Z", 0)).toBe("1m 5s");
    });

    it("measures a running deployment up to now", () => {
        const now = new Date("2026-10-06T12:00:30.000Z").getTime();

        expect(deploymentDuration(new Date(createdAt), null, now)).toBe("30s");
    });
});

describe("elapsed", () => {
    it("pads seconds for live progress rows", () => {
        const from = new Date("2026-10-06T12:00:00.000Z");

        expect(elapsed(from, from.getTime() + 65_000)).toBe("1:05");
        expect(elapsed(from, from.getTime() + 600_000)).toBe("10:00");
    });

    it("never counts backwards when the server clock is ahead", () => {
        expect(elapsed("2026-10-06T12:00:10.000Z", Date.parse("2026-10-06T12:00:00.000Z"))).toBe(
            "0:00",
        );
    });
});

describe("date inputs", () => {
    it("round-trips a stored ISO date through the datetime-local value", () => {
        const date = new Date(2026, 9, 6, 14, 30, 15);

        expect(toLocalDateInput(date)).toBe("2026-10-06T14:30:15");
        expect(parseDateInput(date.toISOString())).toBe("2026-10-06T14:30:15");
    });

    it("shows nothing for an invalid stored date", () => {
        expect(parseDateInput("not a date")).toBe("");
        expect(parseDateInput("")).toBe("");
    });
});
