/**
 * Comment-stripped Containerfile (Issue #4393).
 *
 * Apple `container` rejects a Dockerfile larger than 16,384 bytes
 * (apple/container#735; a file within a few bytes of the cap has failed
 * with an unexplained "Stream unexpectedly closed"). The committed
 * `container/Containerfile` is mostly comments — the pins and the reasons
 * behind them are what make it reviewable — so the launcher and CI build
 * from a stripped copy instead: comment lines and blank lines removed,
 * everything else byte-for-byte.
 *
 * Semantics: the Dockerfile parser itself removes comment lines (a line
 * whose first non-blank character is `#`) before instructions are parsed —
 * including inside a `\` continuation — and ignores blank lines within a
 * continuation, so dropping them changes nothing. Parser directives
 * (`# syntax=`, `# escape=`) are only honoured at the very top, before any
 * instruction or ordinary comment, and are kept there.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Hard cap Apple `container` enforces on a Dockerfile, with headroom. */
export const CONTAINERFILE_SIZE_CAP_BYTES = 15_000;

/** File name of the stripped copy the launch plan builds from. */
export const STRIPPED_CONTAINERFILE_SUFFIX = ".Containerfile";

const PARSER_DIRECTIVE_RE = /^#\s*(syntax|escape|check)\s*=/i;

/** Remove comment lines and blank lines; keep leading parser directives. */
export function stripContainerfile(text: string): string {
  const out: string[] = [];
  let atTop = true;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (trimmed.startsWith("#")) {
      if (atTop && PARSER_DIRECTIVE_RE.test(trimmed)) {
        out.push(line);
        continue;
      }
      // An ordinary comment at the top ends the directive block, as the
      // parser's own rule does — but the comment itself is dropped.
      atTop = false;
      continue;
    }
    atTop = false;
    out.push(line);
  }
  return out.length === 0 ? "" : out.join("\n") + "\n";
}
