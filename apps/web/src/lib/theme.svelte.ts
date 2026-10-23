import { browser } from "$app/environment";

export const themes = ["system", "light", "dark"] as const;

export type Theme = (typeof themes)[number];

export const themeLabels: Record<Theme, string> = {
    system: "System",
    light: "Light",
    dark: "Dark",
};

function readTheme(): Theme {
    if (!browser) return "dark";
    const value = document.cookie.match(/(?:^|; )theme=(\w+)/)?.[1];

    return themes.find((theme) => theme === value) ?? "dark";
}

// Per device, in a cookie so the inline script in app.html can apply it before first paint.
export const theme = $state({ current: readTheme() });

export function setTheme(value: Theme) {
    theme.current = value;
    document.cookie = `theme=${value}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.classList.toggle(
        "dark",
        value === "dark" ||
            (value === "system" && matchMedia("(prefers-color-scheme: dark)").matches),
    );
}
