// Subset of Vite's `import.meta.glob`; this package is only ever bundled by Vite.
interface ImportMeta {
    glob<T>(
        pattern: string | string[],
        options: { eager: true; exhaustive?: boolean; query: string; import: "default" },
    ): Record<string, T>;
}
