/**
 * Parse and validate the GitHub Pages Content-Security-Policy meta tag in
 * `_includes/head-custom.html` — Issue #271.
 *
 * GitHub Pages cannot set HTTP response headers, so a
 * `<meta http-equiv="Content-Security-Policy">` is the only CSP delivery
 * option. The Pages site already pins Mermaid with SRI and
 * `securityLevel: 'strict'`; the CSP is the backstop those two would fall
 * through to if a version bump loosened `strict` or the SRI hash drifted.
 *
 * `'unsafe-inline'` is required in both `script-src` and `style-src`. The
 * published include ships a large inline theme `<style>` and an inline
 * `<script>` that rewrites `.md` links, slugs headings, and calls
 * `mermaid.initialize` / `mermaid.run`. Hash-pinning those blobs would break
 * on every edit. The rest of the policy stays tight: `default-src 'none'`,
 * `script-src` limited to that inline blob plus the pinned jsDelivr origin
 * (SRI on the `<script>` tag remains the integrity check), and no
 * `unsafe-eval` or wildcard hosts.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** Origin of the pinned Mermaid CDN script in `head-custom.html`. */
export const MERMAID_CDN_ORIGIN = "https://cdn.jsdelivr.net";

/** The parsed `content` of a Pages CSP `<meta>` tag. */
export interface PagesCspMeta {
  /** The `content` attribute — the CSP policy string. */
  content: string;
}

/**
 * Read a quoted HTML attribute. Double-quoted values are preferred because
 * CSP keywords use single quotes (`'none'`, `'unsafe-inline'`).
 */
function quotedAttr(
  tag: string,
  name: "http-equiv" | "content",
): string | undefined {
  if (name === "http-equiv") {
    return tag.match(/\bhttp-equiv\s*=\s*"([^"]*)"/i)?.[1] ??
      tag.match(/\bhttp-equiv\s*=\s*'([^']*)'/i)?.[1];
  }
  return tag.match(/\bcontent\s*=\s*"([^"]*)"/i)?.[1] ??
    tag.match(/\bcontent\s*=\s*'([^']*)'/i)?.[1];
}

/**
 * Extract the first `<meta http-equiv="Content-Security-Policy">` from the
 * given HTML source.
 *
 * Attribute order is not significant. Returns `null` when no CSP meta tag
 * is present.
 */
export function parsePagesCspMeta(html: string): PagesCspMeta | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    const httpEquiv = quotedAttr(tag, "http-equiv");
    if (httpEquiv?.toLowerCase() !== "content-security-policy") continue;
    const content = quotedAttr(tag, "content");
    if (content !== undefined) return { content };
  }
  return null;
}

/**
 * Split a CSP `content` string into a directive → source-list map.
 * Directive names are lower-cased; source tokens keep their original form.
 */
export function parseCspDirectives(
  content: string,
): Map<string, readonly string[]> {
  const directives = new Map<string, readonly string[]>();
  for (const part of content.split(";")) {
    const tokens = part.trim().split(/\s+/).filter((t) => t.length > 0);
    const name = tokens[0]?.toLowerCase();
    if (!name) continue;
    directives.set(name, tokens.slice(1));
  }
  return directives;
}

function sourcesOf(
  directives: Map<string, readonly string[]>,
  name: string,
): readonly string[] | undefined {
  return directives.get(name);
}

function isExactlyNone(sources: readonly string[] | undefined): boolean {
  return sources !== undefined &&
    sources.length === 1 &&
    sources[0] === "'none'";
}

function allowsMermaidCdn(sources: readonly string[] | undefined): boolean {
  if (!sources) return false;
  return sources.some((source) =>
    source === MERMAID_CDN_ORIGIN ||
    source.startsWith(`${MERMAID_CDN_ORIGIN}/`)
  );
}

function hasWildcardHost(sources: readonly string[] | undefined): boolean {
  if (!sources) return false;
  return sources.some((source) =>
    source === "*" || source === "https:" || source === "http:" ||
    source.includes("*")
  );
}

/**
 * True when the policy is a tight XSS backstop: `default-src` and
 * `object-src` are `'none'`, `script-src` permits the Mermaid CDN origin
 * (and nothing wildcarded), and `unsafe-eval` is absent.
 *
 * `'unsafe-inline'` on `script-src` / `style-src` is *not* treated as
 * looseness here — see the file-level note. Use
 * {@link permitsExistingPagesInlineAssets} for that site-function check.
 */
export function isTightPagesCsp(csp: PagesCspMeta | null): boolean {
  if (csp === null) return false;
  const directives = parseCspDirectives(csp.content);
  const scriptSrc = sourcesOf(directives, "script-src");
  return isExactlyNone(sourcesOf(directives, "default-src")) &&
    isExactlyNone(sourcesOf(directives, "object-src")) &&
    allowsMermaidCdn(scriptSrc) &&
    !hasWildcardHost(scriptSrc) &&
    !(scriptSrc?.includes("'unsafe-eval'") ?? false);
}

/**
 * True when the policy still permits the inline theme stylesheet, the
 * inline Mermaid init script, and the layout favicons (`'self'` file +
 * `data:` URI) already shipped in `_layouts/default.html`.
 */
export function permitsExistingPagesInlineAssets(
  csp: PagesCspMeta | null,
): boolean {
  if (csp === null) return false;
  const directives = parseCspDirectives(csp.content);
  const scriptSrc = sourcesOf(directives, "script-src") ?? [];
  const styleSrc = sourcesOf(directives, "style-src") ?? [];
  const imgSrc = sourcesOf(directives, "img-src") ?? [];
  return scriptSrc.includes("'unsafe-inline'") &&
    styleSrc.includes("'unsafe-inline'") &&
    imgSrc.includes("'self'") &&
    imgSrc.includes("data:");
}
