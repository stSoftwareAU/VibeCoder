/**
 * Reading launcher source: dialects and comment stripping (Issues #4147, #4).
 *
 * The launch contract in `launcher_contract.ts` bans a host-execution path
 * outright — containment is mandatory (Issue #4), so a launcher that can run
 * the worker on the host is a fault whatever gates it. Judging that needs
 * each source line with its comments removed: a comment naming
 * `run-entrypoint` cannot start the worker, and must not be read as if it
 * could. This module is that stripping, per dialect.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

/** Script languages the launchers are written in. */
export type LauncherDialect = "bash" | "powershell";

/**
 * Strip a bash line comment.
 *
 * A `#` only opens a comment at the start of a word, so `${VAR#prefix}`
 * survives.
 */
function stripBashComment(line: string): string {
  return line.replace(/(^|\s)#.*$/, "$1");
}

/**
 * Strip PowerShell comments, line and block, from a whole source.
 *
 * Returns one entry per source line so line numbering is preserved.
 */
function stripPowerShellComments(source: string): string[] {
  let blockComment = false;

  return source.split("\n").map((raw) => {
    let code = "";
    for (let index = 0; index < raw.length; index++) {
      if (blockComment) {
        if (raw.startsWith("#>", index)) {
          blockComment = false;
          index++;
        }
        continue;
      }
      if (raw.startsWith("<#", index)) {
        blockComment = true;
        index++;
        continue;
      }
      if (raw[index] === "#") break; // Line comment: nothing after it runs.
      code += raw[index];
    }
    return code;
  });
}

/**
 * The launcher's source lines with comments stripped.
 *
 * Execution markers only matter where they can execute, so the contract rules
 * match against these rather than the raw source.
 *
 * @param source - The launcher's full source text
 * @param dialect - Language the launcher is written in
 * @returns One stripped line per source line, in order
 */
export function executableLines(
  source: string,
  dialect: LauncherDialect,
): string[] {
  return dialect === "bash"
    ? source.split("\n").map(stripBashComment)
    : stripPowerShellComments(source);
}
