import type { AppRouterClient } from "@stoat/api/routers/index";
import { Match } from "effect";
import * as v from "valibot";

import { lenient } from "./lenient";

const text = lenient(
    v.pipe(
        v.string(),
        v.check((value) => value.trim().length > 0),
    ),
);

const inspectionSchema = v.object({
    Id: text,
    Name: text,
    Image: text,
    Config: lenient(v.object({ Image: text })),
    State: lenient(
        v.object({
            Status: text,
            Health: lenient(v.object({ Status: text })),
        }),
    ),
});

export function containerInfo(
    container: Awaited<
        ReturnType<AppRouterClient["resources"]["getContainers"]>
    >[number]["container"],
) {
    const inspection = v.parse(inspectionSchema, container);
    const health = inspection.State?.Health?.Status;
    const id = inspection.Id;

    return {
        id,
        name: inspection.Name?.replace(/^\//u, "") || id || "Unnamed container",
        image: inspection.Config?.Image ?? inspection.Image ?? "Unknown image",
        status: inspection.State?.Status ?? "unknown",
        health: health ?? "Unknown",
        healthVariant: Match.value(health).pipe(
            Match.when("healthy", () => "success" as const),
            Match.when("unhealthy", () => "error" as const),
            Match.when("starting", () => "warning" as const),
            Match.orElse(() => "secondary" as const),
        ),
    };
}
