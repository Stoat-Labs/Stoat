// The web app validates these through varlock at startup; the packages read them here so every
// check and error message is the same. Each call reads process.env, so tests can stub values.

/** The root secret every encryption and signing key is derived from. */
export function appSecret() {
    const secret = process.env.APP_SECRET;

    if (!secret || Buffer.byteLength(secret) < 32)
        throw new Error("APP_SECRET must contain at least 32 bytes");

    return secret;
}

/** Stoat's public URL, if it is set and parses. */
export function appUrl() {
    const url = process.env.APP_URL;

    return url && URL.canParse(url) ? url : undefined;
}

export function databaseUrl() {
    const url = process.env.DATABASE_URL;

    if (!url) throw new Error("DATABASE_URL is required.");

    return url;
}
