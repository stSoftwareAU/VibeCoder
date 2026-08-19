/**
 * Parse and validate the Mermaid CDN `<script>` tag in the GitHub Pages head
 * include (`_includes/head-custom.html`) — Issue #3169.
 *
 * The Pages site loads Mermaid from a third-party CDN on every rendered page.
 * A floating major-version pin (`mermaid@10`) resolves to the latest `10.x` at
 * request time and carries no Subresource Integrity (SRI) hash, so a
 * compromised CDN or hijacked upstream package could execute arbitrary
 * JavaScript in the page context with nothing to stop it — a supply-chain XSS
 * vector. The published tag must therefore pin an exact version and carry a
 * matching `integrity` (SRI) hash alongside `crossorigin`.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** The parsed attributes of the Mermaid CDN `<script>` tag. */
export interface MermaidCdnScript {
  /** The full `src` URL. */
  src: string;
  /** The version specifier from the URL (e.g. `10.9.6` or `10`). */
  version: string | null;
  /** The `integrity` (SRI) attribute value, or null when absent. */
  integrity: string | null;
  /** The `crossorigin` attribute value, or null when absent. */
  crossorigin: string | null;
}

/** Matches an exact semver pin: `X.Y.Z` (no floating major/minor tag). */
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

/** Matches a valid SRI hash: `sha256|sha384|sha512-<base64>`. */
const SRI_HASH = /^sha(256|384|512)-[A-Za-z0-9+/]+=*$/;

/**
 * Extract the Mermaid CDN `<script>` tag from the given HTML source.
 *
 * Returns the parsed `src`, `version`, `integrity` and `crossorigin`, or
 * `null` when no Mermaid CDN script tag is present.
 */
export function parseMermaidCdnScript(html: string): MermaidCdnScript | null {
  // Find a <script ...> tag whose src references the mermaid CDN asset.
  const tagMatch = html.match(
    /<script\b[^>]*\bsrc\s*=\s*['"][^'"]*mermaid[^'"]*['"][^>]*>/i,
  );
  if (!tagMatch) return null;
  const tag = tagMatch[0];

  const src = tag.match(/\bsrc\s*=\s*['"]([^'"]+)['"]/i)?.[1] ?? "";
  const integrity = tag.match(/\bintegrity\s*=\s*['"]([^'"]+)['"]/i)?.[1] ??
    null;
  const crossorigin = tag.match(/\bcrossorigin\s*=\s*['"]([^'"]+)['"]/i)?.[1] ??
    null;
  const version = src.match(/mermaid@([^/]+)/)?.[1] ?? null;

  return { src, version, integrity, crossorigin };
}

/** True when the version string is a fully-qualified `X.Y.Z` pin. */
export function isExactVersionPin(version: string | null): boolean {
  return version !== null && EXACT_VERSION.test(version);
}

/** True when the given value is a well-formed SRI hash. */
export function isValidSriHash(integrity: string | null): boolean {
  return integrity !== null && SRI_HASH.test(integrity);
}

/**
 * True when the Mermaid CDN script is hardened: an exact version pin, a valid
 * SRI `integrity` hash, and a `crossorigin` attribute (required for SRI to be
 * enforced on a cross-origin request).
 */
export function isHardenedMermaidCdnScript(
  script: MermaidCdnScript | null,
): boolean {
  return script !== null &&
    isExactVersionPin(script.version) &&
    isValidSriHash(script.integrity) &&
    script.crossorigin !== null;
}
