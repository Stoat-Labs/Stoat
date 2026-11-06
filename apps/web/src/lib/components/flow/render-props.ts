import { createAttachmentKey } from "svelte/attachments";

export function withElementAttachment<T extends HTMLElement, P extends Record<string, unknown>>(
    props: P,
    setter: (element: T | null) => void,
) {
    const key = createAttachmentKey();

    // SAFETY: only adds the attachment's symbol key to P, which consumers spread onto an element.
    return {
        ...props,
        [key]: (element: T) => {
            setter(element);

            return () => setter(null);
        },
    } as P;
}
