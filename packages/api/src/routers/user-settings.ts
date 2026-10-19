import { getUserSettings, setCanvasMode } from "@stoat/db/settings";
import * as v from "valibot";

import { protectedProcedure } from "..";

export const userSettingsRouter = {
    get: protectedProcedure.handler(({ context: { db, session } }) =>
        getUserSettings(db, session.user.id),
    ),

    update: protectedProcedure
        .input(v.object({ canvasMode: v.boolean() }))
        .handler(async ({ context: { db, session }, input }) => {
            await setCanvasMode(db, session.user.id, input.canvasMode);

            return input;
        }),
};
