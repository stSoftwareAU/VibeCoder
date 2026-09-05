/**
 * JSONC support — `deno.jsonc` and friends may carry `//` and `/* … *\/`
 * comments and trailing commas, which `JSON.parse` refuses.
 *
 * Extracted from `orphan_deps_scanner.ts` (which re-exports it, so its
 * callers are unchanged) so a module that only needs to read a manifest does
 * not pull in the whole scanner's dependency graph (Issue #974).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * Strip `//` line comments, `/* … *\/` block comments, and trailing commas
 * from a JSONC document, preserving string literals (so `"https://…"` and a
 * `//` inside a string are not mistaken for a comment). Returns plain JSON.
 *
 * Pure — no I/O.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let stringQuote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === stringQuote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      stringQuote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      // Skip to end of line.
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // lands on the closing '/'
      continue;
    }
    out += ch;
  }
  // Drop trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1");
}
