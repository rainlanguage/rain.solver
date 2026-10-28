import { createHash } from "crypto";
import { Exception } from "@opentelemetry/api";

/** The urls in a text, in any letter case, see redactUrls */
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"<>`]+/gi;

/** The path of a url that is masked already, see redactUrl */
const MASKED_PATH = /^\/\[redacted:[0-9a-f]{8}\]$/;

/**
 * The punctuation that can follow a url in a text, it is kept out of the url,
 * a closing square bracket is not, a masked url ends with one
 */
const TRAILING_PUNCTUATION = /[.,;:!?)}']+$/;

/**
 * Masks the secret parts of the given url, ie its credentials, path, query and
 * fragment, where rpc providers put the api keys, it keeps the scheme and host
 * and adds a short hash of the whole url, so masked urls of one host stay
 * distinguishable, a url with nothing past its host is returned as is. The hash
 * leaves out the trailing slashes, so a url and its normalized form, see
 * normalizeUrl, get the same hash in every span. A url that is masked already
 * is returned as is, so a text masked twice keeps the same hash. The host is
 * never masked, so a provider that puts the key in the subdomain is not covered
 * @param url - The url to mask
 */
export function redactUrl(url: string): string {
    const hash = createHash("sha256").update(url.replace(/\/+$/, "")).digest("hex").slice(0, 8);
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return `[redacted:${hash}]`;
    }
    const hasExtra = !!parsed.username || !!parsed.password || !!parsed.search || !!parsed.hash;
    if (!hasExtra && (parsed.pathname.length <= 1 || MASKED_PATH.test(parsed.pathname))) {
        return url;
    }
    return `${parsed.protocol}//${parsed.host}/[redacted:${hash}]`;
}

/**
 * Masks every url in the given text, see redactUrl. The message of a failed
 * rpc call carries the full url of the rpc, with its api key. Punctuation right
 * after a url stays in the text, so the url gets the same hash as elsewhere
 * @param text - The text to mask, an error message say
 */
export function redactUrls(text: string): string {
    return text.replace(URL_PATTERN, (match) => {
        const trailing = TRAILING_PUNCTUATION.exec(match)?.[0] ?? "";
        return redactUrl(match.slice(0, match.length - trailing.length)) + trailing;
    });
}

/**
 * Masks the urls in the message and the stack of the given exception, see
 * redactUrls. An exception with no url is returned as is, else a copy with the
 * same name and code, a stack that is not a string is left out of the copy. A
 * value that is not an object, a thrown undefined say, is returned as is, the
 * span skips it
 * @param exception - The exception to mask
 */
export function redactException(exception: Exception): Exception {
    if (typeof exception === "string") return redactUrls(exception);
    if (!exception || typeof exception !== "object") return exception;
    const message =
        exception.message === undefined ? undefined : redactUrls(String(exception.message));
    const stack = typeof exception.stack === "string" ? redactUrls(exception.stack) : undefined;
    if (message === exception.message && stack === exception.stack) return exception;
    const masked: Error & { code?: string | number } = new Error(message);
    masked.name = exception.name ?? "Error";
    masked.stack = stack;
    if (exception.code !== undefined) masked.code = exception.code;
    return masked;
}
