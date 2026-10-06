/**
 * The Content Security Policy of the pages (architecture section 9.7), one nonce per request: the document's own
 * scripts run (Next marks the ones it writes with the nonce it finds in this header, and the root layout marks the
 * theme script), nothing else does, and what a page may load or send is this server and nothing else. The pages
 * render Markdown the Dot wrote (react-markdown, which never writes raw HTML), so this is the second line behind that
 * one, and it also keeps the page from being framed. Styles may be inline (React writes `style=` attributes for the
 * widths of meters and bars); images may be blob: URLs (the pictures of the Dot's computer are read through the API and
 * shown from memory).
 */
export function contentSecurityPolicy(nonce: string, development = process.env.NODE_ENV === "development"): string {
  return [
    "default-src 'self'",
    // React's development build reads back server stacks with eval; the production build does not.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A fresh nonce: 128 random bits, base64. */
export function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
}
