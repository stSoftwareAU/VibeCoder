/**
 * Parse the Mermaid `securityLevel` from the GitHub Pages head include
 * (`_includes/head-custom.html`) — Issue #2489.
 *
 * The Pages site renders the text of every page code block as a Mermaid
 * diagram. In `securityLevel: 'loose'` Mermaid does not sanitise HTML in
 * node labels and permits interactive `click`/`call`/`href` directives
 * (including `javascript:` hrefs), which is a stored-XSS vector when the
 * diagram content is influenced by untrusted issue/PR text. The published
 * config must therefore use a safe security level (`strict` or
 * `antiscript`).
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** Mermaid security levels that escape HTML and disable click/href directives. */
export const SAFE_SECURITY_LEVELS = ["strict", "antiscript"] as const;

/**
 * Extract the `securityLevel` value passed to `mermaid.initialize({ ... })`
 * in the given HTML source.
 *
 * Returns the level string (e.g. `"strict"`) or `null` when no
 * `securityLevel` key is present.
 */
export function extractMermaidSecurityLevel(html: string): string | null {
  const match = html.match(/securityLevel\s*:\s*['"]([^'"]+)['"]/);
  return match?.[1] ?? null;
}

/**
 * True when the given security level escapes HTML in labels and disables
 * `click`/`call`/`href` directives — i.e. is not the unsafe `loose` (or
 * the now-removed `sandbox` exception is not granted here).
 */
export function isSafeSecurityLevel(level: string | null): boolean {
  return level !== null &&
    (SAFE_SECURITY_LEVELS as readonly string[]).includes(level);
}
