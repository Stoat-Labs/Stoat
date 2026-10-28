import { FileTree as Model, preloadFileTree } from "@pierre/trees";
import { createRawSnippet, flushSync, hydrate, mount, unmount } from "svelte";
import { createServer } from "vite-plus";
import { expect, test, vi } from "vite-plus/test";
import { FileTree, useFileTreeSelection } from "../../packages/trees/src";

const options = { id: "t", paths: ["a.ts", "src/b.ts"], initialExpansion: "open" as const };

const header = createRawSnippet(() => ({ render: () => "<strong>Files</strong>" }));

const contextMenu = createRawSnippet((item: () => { path: string }) => ({
    render: () => `<span>Menu ${item().path}</span>`,
}));

const tick = () => new Promise((resolve) => setTimeout(resolve));

function host() {
    return document.querySelector("file-tree-container")!;
}

test("mounts, slots the header, opens the menu, and tracks selection", async () => {
    const model = new Model(options);
    let selected = "";

    const stopTracking = $effect.root(() => {
        const selection = useFileTreeSelection(model);
        $effect(() => {
            selected = selection.current.join(",");
        });
    });

    const app = mount(FileTree, { target: document.body, props: { model, header, contextMenu } });
    flushSync();

    expect(host().shadowRoot?.querySelector("[data-file-tree-id]")).toBeTruthy();
    expect(host().querySelector('[slot="header"]')?.textContent).toBe("Files");

    await tick();
    host()
        .shadowRoot!.querySelector('[data-item-path="a.ts"]')!
        .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    await tick();
    flushSync();
    expect(host().querySelector('[slot="context-menu"]')?.textContent).toBe("Menu a.ts");
    model.getComposition()!.contextMenu!.onClose!();
    flushSync();
    expect(host().querySelector('[slot="context-menu"]')).toBeNull();

    model.getItem("a.ts")!.select();
    flushSync();
    expect(selected).toBe("a.ts");

    unmount(app);
    stopTracking();
    expect(model.getComposition()).toBeUndefined();
    document.body.innerHTML = "";
});

test("swapping the model restores the old one and wraps the new one", () => {
    const a = new Model({ paths: ["a.ts"] });
    const b = new Model({ paths: ["b.ts"] });
    const props = $state({ model: a, contextMenu });

    const app = mount(FileTree, { target: document.body, props });
    flushSync();
    expect(a.getComposition()?.contextMenu?.enabled).toBe(true);

    props.model = b;
    flushSync();
    expect(a.getComposition()).toBeUndefined();
    expect(b.getComposition()?.contextMenu?.enabled).toBe(true);
    expect(host().shadowRoot!.querySelector('[data-item-path="b.ts"]')).toBeTruthy();

    unmount(app);
    expect(b.getComposition()).toBeUndefined();
    document.body.innerHTML = "";
});

test("hydrates SSR output with a declarative shadow root", async () => {
    // Load a server-compiled copy of the component, as SvelteKit would.
    const vite = await createServer({ server: { middlewareMode: true }, appType: "custom" });
    const { render } = await vite.ssrLoadModule("svelte/server");

    const ServerFileTree = (
        await vite.ssrLoadModule(
            new URL("../../packages/trees/src/FileTree.svelte", import.meta.url).pathname,
        )
    ).default;

    await vite.close();

    const model = new Model(options);
    const preloadedData = preloadFileTree(options);
    const { body } = render(ServerFileTree, { props: { model, preloadedData } });
    expect(body).toContain('<template shadowrootmode="open">');

    // jsdom lacks declarative shadow DOM, so do what the browser parser does.
    document.body.innerHTML = body;

    for (const t of document.querySelectorAll<HTMLTemplateElement>("template[shadowrootmode]")) {
        t.parentElement!.attachShadow({ mode: "open" }).append(t.content);
        t.remove();
    }

    const ssrRoot = host().shadowRoot!.querySelector("[data-file-tree-id]");
    const warn = vi.spyOn(console, "warn");

    const app = hydrate(FileTree, { target: document.body, props: { model, preloadedData } });
    flushSync();
    expect(warn).not.toHaveBeenCalled();
    expect(host().id).toBe("t");
    expect(host().shadowRoot!.querySelector("[data-file-tree-id]")).toBe(ssrRoot);
    unmount(app);
    document.body.innerHTML = "";
});

test("client-side mount with preloadedData (SvelteKit client navigation)", () => {
    const warn = vi.spyOn(console, "warn");
    const model = new Model(options);

    const app = mount(FileTree, {
        target: document.body,
        props: { model, preloadedData: preloadFileTree(options) },
    });

    flushSync();
    expect(host().shadowRoot!.querySelector('[data-item-path="a.ts"]')).toBeTruthy();
    expect(warn).not.toHaveBeenCalled();
    unmount(app);
});
