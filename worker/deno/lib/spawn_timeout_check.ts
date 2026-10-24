/**
 * Quality gate check: every worker subprocess spawn carries an explicit
 * timeout (Issue #4248).
 *
 * Two shapes skip the timeout and can hang a run:
 *
 *  - `new Deno.Command(` in `worker/deno/lib` or `worker/deno/commands` with
 *    no `signal`, outside the chokepoint modules that own the timeout, and
 *  - a `runWithTimeout(` call that imports the helper from
 *    `subprocess_timeout.ts` and passes no `timeoutMs`.
 *
 * Any offender fails the check. There is no baseline of known gaps.
 *
 * Scanning reuses the directory walk from `spawn_chokepoint_scan.ts`.
 * Comments and strings are blanked in one pass, so a `//` inside a URL
 * string is not read as a comment that swallows the rest of the line and
 * leaves a quote open. The match itself is string walking: a
 * `new RegExp(...)` built from a variable is what the gate's semgrep stage
 * rejects.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { walkTsFiles } from "./spawn_chokepoint_scan.ts";

/** How an offending call skipped its timeout. */
export type SpawnTimeoutKind = "deno-command" | "run-with-timeout";

/** One spawn that carries no explicit timeout. */
export interface SpawnTimeoutViolation {
  /** Repo-relative path of the offending file. */
  file: string;
  /** 1-based line number of the offending call. */
  line: number;
  /** Trimmed text of that line. */
  text: string;
  /** Which shape was missing its timeout. */
  kind: SpawnTimeoutKind;
}

/** Offences found in one scan, plus how many files were read. */
export interface SpawnTimeoutScanResult {
  offences: SpawnTimeoutViolation[];
  filesScanned: number;
}

/**
 * Modules that own the subprocess timeout. Their own `Deno.Command` is the
 * timeout implementation, so the check does not flag them.
 */
export const SPAWN_TIMEOUT_CHOKEPOINTS: ReadonlySet<string> = new Set([
  "worker/deno/lib/gh_spawn.ts",
  "worker/deno/lib/git_timeout.ts",
  "worker/deno/lib/subprocess_timeout.ts",
]);

/** Directories the quality gate scans for an untimed spawn. */
export const SPAWN_TIMEOUT_SCAN_DIRS: readonly string[] = [
  "worker/deno/lib",
  "worker/deno/commands",
];

const COMMAND_NEEDLE = "new Deno.Command";
const RUN_NEEDLE = "runWithTimeout";
const TIMEOUT_WORD = "timeoutMs";
const SIGNAL_WORD = "signal";
const SUBPROCESS_MODULE = "subprocess_timeout.ts";

function isIdentChar(char: string): boolean {
  if (char >= "A" && char <= "Z") return true;
  if (char >= "a" && char <= "z") return true;
  if (char >= "0" && char <= "9") return true;
  return char === "_" || char === "$";
}

function isSpace(char: string): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

/** True when `word` occurs in `text` bounded by non-identifier characters. */
function hasWord(text: string, word: string): boolean {
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(word, from);
    if (at < 0) return false;
    const before = at > 0 ? text.charAt(at - 1) : "";
    const after = text.charAt(at + word.length);
    const leftFree = before === "" || !isIdentChar(before);
    const rightFree = after === "" || !isIdentChar(after);
    if (leftFree && rightFree) return true;
    from = at + word.length;
  }
  return false;
}

function blankQuoted(
  chars: string[],
  start: number,
  end: number,
  quote: string,
): number {
  chars[start] = " ";
  let index = start + 1;
  while (index < end) {
    if (chars[index] === "\\") {
      chars[index] = " ";
      if (index + 1 < end && chars[index + 1] !== "\n") {
        chars[index + 1] = " ";
      }
      index += 2;
      continue;
    }
    if (chars[index] === quote) {
      chars[index] = " ";
      return index + 1;
    }
    // A quoted string cannot span lines. Stopping here keeps a stray quote
    // (a regex such as /["']/) from blanking the code that follows.
    if (chars[index] === "\n") return index;
    chars[index] = " ";
    index++;
  }
  return index;
}

function blankTemplate(chars: string[], start: number, end: number): number {
  chars[start] = " ";
  let index = start + 1;
  while (index < end) {
    if (chars[index] === "\\") {
      chars[index] = " ";
      if (index + 1 < end && chars[index + 1] !== "\n") {
        chars[index + 1] = " ";
      }
      index += 2;
      continue;
    }
    if (chars[index] === "`") {
      chars[index] = " ";
      return index + 1;
    }
    if (chars[index] === "$" && chars[index + 1] === "{") {
      chars[index] = " ";
      chars[index + 1] = " ";
      index += 2;
      let depth = 1;
      while (index < end && depth > 0) {
        const char = chars[index];
        if (char === '"' || char === "'") {
          index = blankQuoted(chars, index, end, char);
          continue;
        }
        if (char === "`") {
          index = blankTemplate(chars, index, end);
          continue;
        }
        if (char === "{") depth++;
        else if (char === "}") {
          depth--;
          if (depth === 0) {
            chars[index] = " ";
            index++;
            break;
          }
        }
        index++;
      }
      continue;
    }
    if (chars[index] !== "\n") chars[index] = " ";
    index++;
  }
  return index;
}

/**
 * Blank comments and string contents in one pass.
 *
 * `code` has comments blanked and strings kept, for the import check.
 * `blanked` has both blanked, for the call match. Newlines stay put in both
 * so an index still names the original line. Code inside a template `${...}`
 * is left intact.
 */
function lexSource(source: string): { code: string; blanked: string } {
  const code = [...source];
  const blanked = [...code];
  const end = blanked.length;
  const blankBoth = (from: number, to: number) => {
    for (let at = from; at < to; at++) {
      if (blanked[at] === "\n") continue;
      code[at] = " ";
      blanked[at] = " ";
    }
  };
  let index = 0;
  while (index < end) {
    const char = blanked[index];
    const next = blanked[index + 1];
    if (char === "/" && next === "/") {
      let stop = index;
      while (stop < end && blanked[stop] !== "\n") stop++;
      blankBoth(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      let stop = index + 2;
      while (
        stop < end && !(blanked[stop] === "*" && blanked[stop + 1] === "/")
      ) {
        stop++;
      }
      stop = Math.min(stop + 2, end);
      blankBoth(index, stop);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'") {
      index = blankQuoted(blanked, index, end, char);
      continue;
    }
    if (char === "`") {
      index = blankTemplate(blanked, index, end);
      continue;
    }
    index++;
  }
  return { code: code.join(""), blanked: blanked.join("") };
}

function endOfCall(code: string, openParen: number): number {
  let depth = 0;
  for (let index = openParen; index < code.length; index++) {
    const char = code[index];
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) return index + 1;
    }
  }
  return code.length;
}

function lineNumber(code: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor++) {
    if (code.charAt(cursor) === "\n") line++;
  }
  return line;
}

function lineText(code: string, line: number): string {
  const lines = code.split("\n");
  return (lines[line - 1] ?? "").trim();
}

function skipSpace(code: string, index: number): number {
  let cursor = index;
  while (cursor < code.length && isSpace(code.charAt(cursor))) cursor++;
  return cursor;
}

/** True when `index` is the name in `function name(`. */
function isFunctionDefinition(code: string, index: number): boolean {
  let cursor = index - 1;
  while (cursor >= 0 && isSpace(code.charAt(cursor))) cursor--;
  const word = "function";
  const start = cursor - word.length + 1;
  if (start < 0) return false;
  if (code.slice(start, cursor + 1) !== word) return false;
  return start === 0 || !isIdentChar(code.charAt(start - 1));
}

function importsRunWithTimeout(code: string): boolean {
  let from = 0;
  while (from < code.length) {
    const at = code.indexOf(SUBPROCESS_MODULE, from);
    if (at < 0) return false;
    let importAt = -1;
    let searchFrom = at;
    while (searchFrom > 0) {
      const found = code.lastIndexOf("import", searchFrom - 1);
      if (found < 0) break;
      const before = found === 0 ? "" : code.charAt(found - 1);
      const after = code.charAt(found + "import".length);
      const leftFree = before === "" || !isIdentChar(before);
      const rightFree = after === "" || !isIdentChar(after);
      if (leftFree && rightFree) {
        importAt = found;
        break;
      }
      searchFrom = found;
    }
    if (importAt >= 0 && hasWord(code.slice(importAt, at), RUN_NEEDLE)) {
      return true;
    }
    from = at + SUBPROCESS_MODULE.length;
  }
  return false;
}

function callOffence(
  original: string,
  blanked: string,
  repoRelPath: string,
  needleAt: number,
  needle: string,
  kind: SpawnTimeoutKind,
  requiredWord: string,
): SpawnTimeoutViolation | null {
  const open = skipSpace(blanked, needleAt + needle.length);
  if (blanked.charAt(open) !== "(") return null;
  const end = endOfCall(blanked, open);
  // `blanked` keeps every newline, so its index names the original line.
  if (hasWord(blanked.slice(open, end), requiredWord)) return null;
  const line = lineNumber(blanked, needleAt);
  return {
    file: repoRelPath,
    line,
    text: lineText(original, line),
    kind,
  };
}

/**
 * Scan one file for spawns that carry no explicit timeout.
 *
 * @param content - Raw file text.
 * @param repoRelPath - Repo-relative path recorded on each offence.
 */
export function scanContentForSpawnTimeout(
  content: string,
  repoRelPath: string,
): SpawnTimeoutViolation[] {
  const { code, blanked } = lexSource(content);
  const offences: SpawnTimeoutViolation[] = [];

  let from = 0;
  while (from < blanked.length) {
    const at = blanked.indexOf(COMMAND_NEEDLE, from);
    if (at < 0) break;
    const offence = callOffence(
      content,
      blanked,
      repoRelPath,
      at,
      COMMAND_NEEDLE,
      "deno-command",
      SIGNAL_WORD,
    );
    if (offence) offences.push(offence);
    from = at + COMMAND_NEEDLE.length;
  }

  if (importsRunWithTimeout(code)) {
    from = 0;
    while (from < blanked.length) {
      const at = blanked.indexOf(RUN_NEEDLE, from);
      if (at < 0) break;
      if (!isFunctionDefinition(blanked, at)) {
        const offence = callOffence(
          content,
          blanked,
          repoRelPath,
          at,
          RUN_NEEDLE,
          "run-with-timeout",
          TIMEOUT_WORD,
        );
        if (offence) offences.push(offence);
      }
      from = at + RUN_NEEDLE.length;
    }
  }

  return offences;
}

/**
 * Scan repo-relative directories for spawns without an explicit timeout.
 *
 * Chokepoint modules are skipped. Test files are skipped: fixtures spawn
 * throwaway processes and are not a production surface.
 */
export async function scanDirectoriesForSpawnTimeout(
  repoRoot: string,
  relDirs: readonly string[],
  chokepoints: ReadonlySet<string> = SPAWN_TIMEOUT_CHOKEPOINTS,
): Promise<SpawnTimeoutScanResult> {
  const root = repoRoot.endsWith("/") ? repoRoot.slice(0, -1) : repoRoot;
  const offences: SpawnTimeoutViolation[] = [];
  let filesScanned = 0;

  for (const relDir of relDirs) {
    for await (const absFile of walkTsFiles(`${root}/${relDir}`, true)) {
      const repoRel = absFile.slice(root.length + 1);
      if (chokepoints.has(repoRel)) continue;
      filesScanned++;
      const content = await Deno.readTextFile(absFile);
      offences.push(...scanContentForSpawnTimeout(content, repoRel));
    }
  }

  return { offences, filesScanned };
}
