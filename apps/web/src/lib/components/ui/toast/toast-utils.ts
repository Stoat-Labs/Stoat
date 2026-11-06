import CircleAlertIcon from "phosphor-svelte/lib/WarningCircleIcon";
import CircleCheckIcon from "phosphor-svelte/lib/CheckCircleIcon";
import InfoIcon from "phosphor-svelte/lib/InfoIcon";
import LoaderCircleIcon from "phosphor-svelte/lib/CircleNotchIcon";
import TriangleAlertIcon from "phosphor-svelte/lib/WarningIcon";

export const TOAST_ICONS = {
    error: CircleAlertIcon,
    info: InfoIcon,
    loading: LoaderCircleIcon,
    success: CircleCheckIcon,
    warning: TriangleAlertIcon,
} as const;

export function upsertReplayClassName(toast: {
    type?: string;
    updateKey?: number;
}): string | undefined {
    const k = toast.updateKey ?? 0;

    if (k <= 0) return undefined;
    const isEven = k % 2 === 0;

    if (toast.type === "error") {
        return isEven ? "animate-toast-error-even" : "animate-toast-error-odd";
    }

    return isEven ? "animate-toast-success-even" : "animate-toast-success-odd";
}
