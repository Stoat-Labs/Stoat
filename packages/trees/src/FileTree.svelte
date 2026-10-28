<script lang="ts" module>
    import type { FileTreeSsrPayload } from "@pierre/trees";

    export type FileTreePreloadedData = Pick<
        FileTreeSsrPayload,
        "id" | "shadowHtml"
    >;
</script>

<script lang="ts">
    import type {
        ContextMenuItem,
        ContextMenuOpenContext,
        FileTree,
        FileTreeCompositionOptions,
    } from "@pierre/trees";
    import type { Snippet } from "svelte";
    import type { HTMLAttributes } from "svelte/elements";

    interface Props extends Omit<
        HTMLAttributes<HTMLElement>,
        "children"
    > {
        model: FileTree;
        header?: Snippet;
        contextMenu?: Snippet<
            [ContextMenuItem, ContextMenuOpenContext]
        >;
        preloadedData?: FileTreePreloadedData;
    }

    let {
        model,
        header,
        contextMenu,
        preloadedData,
        id,
        style,
        ...rest
    }: Props = $props();

    let host: HTMLElement;

    let menu = $state<{
        item: ContextMenuItem;
        context: ContextMenuOpenContext;
    } | null>(null);

    // Snippets replace the matching parts of the model's own composition; the
    // rest is kept, and the original is restored when this component lets go.
    function compose(
        base: FileTreeCompositionOptions | undefined,
    ): FileTreeCompositionOptions | undefined {
        const next: FileTreeCompositionOptions = { ...base };

        if (header) delete next.header;

        if (contextMenu) {
            next.contextMenu = {
                ...base?.contextMenu,
                enabled: true,
                render: undefined,
                onOpen: (item, context) => {
                    menu = { item, context };
                    base?.contextMenu?.onOpen?.(item, context);
                },
                onClose: () => {
                    base?.contextMenu?.onClose?.();
                    menu = null;
                },
            };
        }

        return next.header || next.contextMenu ? next : undefined;
    }

    $effect.pre(() => {
        const m = model;
        const base = m.getComposition();
        m.setComposition(compose(base));

        return () => {
            // The menu slot goes with the old composition, so a re-enabled menu starts closed.
            menu = null;
            m.setComposition(base);
        };
    });

    $effect(() => {
        const m = model;

        if (
            preloadedData &&
            host.shadowRoot?.querySelector("[data-file-tree-id]")
        ) {
            m.hydrate({ fileTreeContainer: host });
        } else {
            m.render({ fileTreeContainer: host });
        }

        return () => m.unmount();
    });
</script>

<file-tree-container
    bind:this={host}
    {...rest}
    id={id ?? preloadedData?.id}
    style="--trees-item-height:{model.getItemHeight()}px;--trees-density-override:{model.getDensityFactor()};{style ??
        ''}"
>
    {#if preloadedData}
        <!-- The browser turns this into the shadow root while parsing SSR HTML. -->
        {@html `<template shadowrootmode="open">${preloadedData.shadowHtml}</template>`}
    {/if}
    {#if header}
        <div slot="header">{@render header()}</div>
    {/if}
    {#if contextMenu && menu}
        <div slot="context-menu">
            {@render contextMenu(menu.item, menu.context)}
        </div>
    {/if}
</file-tree-container>
