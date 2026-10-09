// Client-safe: the variables editor imports this too.

/**
 * `{{ <resourceId>.<KEY> }}` reads a variable from another resource on the same cluster.
 * Anything shaped like `{{ x.Y }}` counts as a reference, so typos fail loudly instead of
 * reaching containers as literal text. Go templates (`{{ .Field }}`) and template
 * placeholders (`{{ UUID }}`) have no `x.` part and never match.
 */
export const VARIABLE_REFERENCE = /\{\{\s*([^\s{}.]+)\.([^\s{}]+)\s*\}\}/gu;

const RESOURCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** The lowercase resource id a reference points at, or undefined when it is not an id. */
export function referenceResourceId(id: string) {
    return RESOURCE_ID.test(id) ? id.toLowerCase() : undefined;
}
