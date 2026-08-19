/**
 * Reading launcher source: dialects and native-branch gating (Issue #4147).
 *
 * The launch contract in `launcher_contract.ts` used to ban a native execution
 * path outright. Milestone #4060 (parent #4145) replaced that with a gating
 * rule: container is the default and native is reachable only through the
 * explicit run-mode opt-in (#4146). Enforcing "only inside an explicit native
 * branch" needs to know, for each source line, whether it sits inside a branch
 * whose condition names the `native` mode — which is what this module reports.
 *
 * The scan is deliberately shallow. It tracks only the constructs a native
 * branch can be written with (`if`/`elif`/`else`/`fi` and `case`/`esac` in
 * bash, brace blocks in PowerShell) and judges a branch native when its
 * condition names the `native` mode. Comments are stripped first: a comment
 * cannot execute the worker, so it must not decide whether execution is gated.
 *
 * ```mermaid
 * flowchart LR
 *     S["launcher source"] --> C["strip comments"]
 *     C --> F["track branch frames"]
 *     F --> G{"condition names<br/>the native mode?"}
 *     G -->|yes| I["lines inside are gated"]
 *     G -->|no| O["lines inside are ungated"]
 * ```
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

/** Script languages the launchers are written in. */
export type LauncherDialect = "bash" | "powershell";

/**
 * Does this branch condition name the native run mode?
 *
 * Word-bounded and case-sensitive: the mode is spelled `native` in
 * `run_mode.ts`, so `$NativeHelper` is not an opt-in.
 *
 * @param condition - Branch condition text
 * @returns True when the condition names the native mode
 */
export function mentionsNativeMode(condition: string): boolean {
  // `seatbelt` (Issue #4300) is native execution under a Seatbelt profile —
  // an explicit run-mode opt-in like `native`, so a branch gated on it is a
  // legitimate host-execution branch, not an ungated escape.
  return /(^|[^A-Za-z0-9_-])(native|seatbelt)([^A-Za-z0-9_-]|$)/.test(
    condition,
  );
}

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

/** One open branch in a bash launcher. */
interface BashFrame {
  /** True when this branch's condition names the native mode. */
  native: boolean;
  /** `case` frames take their branch from the pattern lines inside them. */
  kind: "if" | "case";
}

/** Retarget the innermost open branch, if there is one. */
function retarget(frames: BashFrame[], native: boolean): void {
  const top = frames[frames.length - 1];
  if (top) top.native = native;
}

/** Report, per line, whether a bash line sits inside a native branch. */
function bashNativeGates(lines: string[]): boolean[] {
  const frames: BashFrame[] = [];

  return lines.map((line) => {
    const code = line.trim();

    // Closers and branch switches are applied before the line is judged, so
    // `fi` and `else` sit outside the branch they end.
    if (/^(fi|esac)\b/.test(code)) {
      frames.pop();
    } else if (/^elif\b/.test(code)) {
      retarget(frames, mentionsNativeMode(code));
    } else if (/^else\b/.test(code)) {
      retarget(frames, false);
    } else if (frames[frames.length - 1]?.kind === "case") {
      const pattern = /^([^\s()]+)\)/.exec(code);
      if (pattern) retarget(frames, mentionsNativeMode(pattern[1]!));
    }

    let gated = frames.some((frame) => frame.native);

    // A one-line `if … then … fi` opens and closes on the same line: it
    // executes here, and leaves no frame behind.
    if (/^if\b/.test(code) && /(^|[\s;])fi\s*$/.test(code)) {
      if (mentionsNativeMode(code)) gated = true;
    } else if (/^if\b/.test(code)) {
      const native = mentionsNativeMode(code);
      frames.push({ native, kind: "if" });
      if (native) gated = true;
    } else if (/^case\b/.test(code)) {
      frames.push({ native: false, kind: "case" });
    }

    return gated;
  });
}

/**
 * Report, per line, whether a PowerShell line sits inside a native branch.
 *
 * Brace blocks are the only construct tracked: a frame's condition is the code
 * since the previous brace, falling back to the previous non-blank line so an
 * opening brace on its own line still reads its `if`.
 */
function powershellNativeGates(lines: string[]): boolean[] {
  const frames: boolean[] = [];
  let previousCode = "";

  return lines.map((line) => {
    let gated = false;
    let condition = "";

    // Judged character by character, so a line that only closes a block (`}`
    // or `} else {`) sits outside the branch it ends.
    for (const character of line) {
      if (character === "{") {
        const native = mentionsNativeMode(condition.trim() || previousCode);
        frames.push(native);
        // A one-line `if (…) { … }` executes inside the block it opens.
        if (native) gated = true;
        condition = "";
      } else if (character === "}") {
        frames.pop();
        condition = "";
      } else {
        condition += character;
        if (character.trim() !== "" && frames.some(Boolean)) gated = true;
      }
    }

    if (line.trim() !== "") previousCode = line.trim();
    return gated;
  });
}

/**
 * Report, for every line of a launcher, whether it is inside a native branch.
 *
 * @param source - The launcher's full source text
 * @param dialect - Language the launcher is written in
 * @returns One flag per source line, in order
 */
export function nativeBranchGatedLines(
  source: string,
  dialect: LauncherDialect,
): boolean[] {
  const lines = executableLines(source, dialect);
  return dialect === "bash"
    ? bashNativeGates(lines)
    : powershellNativeGates(lines);
}
