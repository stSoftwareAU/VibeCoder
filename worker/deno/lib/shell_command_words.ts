/**
 * Shell command-word helpers for the AWS Emulator CI checks (Issue #5110,
 * PR #5276 review).
 *
 * These find command words in a GitHub Actions `run:` body; they are not a
 * shell parser. `shellSegments` splits a body into commands, `commandIndex`
 * finds a command's word, and `reachableCommands` drops commands that cannot
 * run (after an unconditional `exit` or `set -n`, behind `false &&`, in a branch or loop
 * whose condition is statically false, in any function body, or inside
 * a here-document). It also reports each reachable command's separators and
 * whether it is an `if`/`elif`/`while`/`until` condition. A construct it cannot judge counts
 * as reachable only when a runtime value decides it, so an unknown condition
 * keeps its commands.
 *
 * Used by aws_emulator_in_ci_check.ts and aws_emulator_workflow_check.ts.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** A command's words and the separator that preceded it (`""` for the first). */
export interface ShellCommand {
  words: string[];
  sep: string;
}

const SHELL_SEPARATORS = new Set([";", "|", "&"]);
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Split a `run:` body into commands, each with its words and the separator
 * before it (`\n`, `;`, `|`, `&`, `&&` or `||`). Quotes keep a word together
 * (`X="a b"` is one word), a backslash-newline joins lines, a newline or
 * `;`/`|`/`&` starts a new command, and a `#` that starts a word ends the line.
 */
export function shellCommands(script: string): ShellCommand[] {
  return shellCommandList(script).commands;
}

/**
 * The commands of {@link shellCommands} and the separator left pending after
 * the last one (`""` when there is none, `"\n"` for a plain line end). A
 * trailing `&` (`cmd &`) is pending here, although it has no command after it.
 */
function shellCommandList(script: string): {
  commands: ShellCommand[];
  trailing: string;
} {
  const text = script.replace(/\\\r?\n/g, " ");
  const commands: ShellCommand[] = [];
  let words: string[] = [];
  let sep = "";
  let word = "";
  let inWord = false;
  let quote: string | null = null;

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  // A blank line keeps a pending `&&`/`||` (`a &&` newline `b` continues).
  const endCommand = (next: string) => {
    endWord();
    if (words.length > 0) {
      commands.push({ words, sep });
      words = [];
      sep = next;
    } else if (next !== "\n") {
      sep = next;
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote !== null) {
      word += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      word += ch;
      inWord = true;
      continue;
    }
    if (ch === "\n") {
      endCommand("\n");
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      endWord();
      continue;
    }
    if (ch === "#" && !inWord) {
      const newline = text.indexOf("\n", i);
      if (newline === -1) break;
      i = newline - 1; // the loop's i++ lands on the newline
      continue;
    }
    if (SHELL_SEPARATORS.has(ch)) {
      const doubled = text.charAt(i + 1) === ch; // `&&` and `||`
      endCommand(doubled ? ch + ch : ch);
      if (doubled) i++;
      continue;
    }
    word += ch;
    inWord = true;
  }
  endCommand("\n");
  return { commands, trailing: sep };
}

/** The words of each command in a `run:` body (see {@link shellCommands}). */
export function shellSegments(script: string): string[][] {
  return shellCommands(script).map((c) => c.words);
}

/**
 * Shell reserved words and plain prefix words that may sit in front of the
 * command word. A word counts only when it stands alone (`then`, not
 * `then;`, which `shellSegments` already splits).
 */
const SHELL_PREFIX_WORDS = new Set([
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
  "!",
  "{",
  "(",
  "sudo",
  "env",
  "exec",
]);
/** `timeout` options that take a separate value word (`-k 5`, `-s KILL`). */
const TIMEOUT_VALUE_OPTIONS = new Set([
  "-k",
  "-s",
  "--kill-after",
  "--signal",
]);

/**
 * Index of the command word. Skips shell reserved words, `sudo`, `env`,
 * `exec`, leading `VAR=value` words, and the wrappers `time` (with `-p`),
 * `nice` (with `-n N` or `-N`), `timeout` (with its options and its duration
 * word) and `command`. `command -v`/`-V` only looks a command up, so it stops
 * the scan at `command` itself. Returns `words.length` when none is found.
 */
export function commandIndex(words: string[]): number {
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (SHELL_PREFIX_WORDS.has(w) || SHELL_ASSIGNMENT.test(w)) {
      i++;
    } else if (w === "time") {
      i++;
      if (words[i] === "-p") i++;
    } else if (w === "nice") {
      i++;
      const next = words[i];
      if (next === "-n") i += 2;
      else if (next !== undefined && /^-n?\d+$/.test(next)) i++;
    } else if (w === "timeout") {
      i++;
      while (i < words.length && (words[i] ?? "").startsWith("-")) {
        i += TIMEOUT_VALUE_OPTIONS.has(words[i] ?? "") ? 2 : 1;
      }
      i++; // the duration
    } else if (w === "command") {
      const next = words[i + 1];
      if (next === "-v" || next === "-V") break;
      i++;
    } else {
      break;
    }
  }
  return i;
}

/**
 * The command words that decide whether, or with what status, the command
 * runs: `!` inverts the exit status and exempts the command from `errexit`;
 * `if`/`elif`/`while`/`until` use the status as a condition, and `until`
 * retries on failure; `then`/`else`/`do` sit in a branch that may not run.
 */
const STATUS_ALTERING_PREFIX_WORDS = new Set([
  "!",
  "if",
  "elif",
  "while",
  "until",
  "then",
  "else",
  "do",
]);

/**
 * Index of the command word like {@link commandIndex}, or -1 when a word in
 * front of it changes whether the command runs or what its status means (see
 * `STATUS_ALTERING_PREFIX_WORDS`). Use it where the command's own exit status
 * must decide the step: `! ./test.sh` turns a failure into a pass.
 */
export function statusPreservingCommandIndex(words: string[]): number {
  const i = commandIndex(words);
  return words.slice(0, i).some((w) => STATUS_ALTERING_PREFIX_WORDS.has(w))
    ? -1
    : i;
}

/** Strip a matching pair of surrounding quotes from a word. */
export function stripQuotes(word: string): string {
  return word.replace(/^(["'])(.*)\1$/, "$2");
}

/**
 * Static exit status of a command: true for `true`/`:`, false for `false`,
 * flipped by each `!`; null when a runtime value decides it.
 */
function staticStatus(words: string[]): boolean | null {
  const i = commandIndex(words);
  const head = stripQuotes(words[i] ?? "");
  const base = head === "true" || head === ":"
    ? true
    : head === "false"
    ? false
    : null;
  if (base === null) return null;
  const negations = words.slice(0, i).filter((w) => w === "!").length;
  return negations % 2 === 1 ? !base : base;
}

/** What a shell's option words (a `bash`/`sh` invocation, or `set`) ask for. */
export interface ShellOptions {
  /** `-n`, `-o noexec` or `--noexec`: commands are read but never run. */
  noexec: boolean;
  /** `-c`: the first operand is a command string, not a script path. */
  commandString: boolean;
  /** Index of the first operand (the script path, for an invocation). */
  operand: number;
  /** `-e` or `-o errexit` (true), `+e` or `+o errexit` (false); null when the words do not say. */
  errexit: boolean | null;
}

/** Long options of `bash` that take a separate value word. */
const SHELL_LONG_VALUE_OPTIONS = new Set(["--rcfile", "--init-file"]);

/**
 * Read the option words of a `bash`/`sh` invocation or a `set` command
 * (`args` starts after the command word). Short clusters such as `-xn` and
 * `-eo pipefail` are read letter by letter; `+n` turns an option back off.
 * Stops at `--`, `-` or the first word that is not an option.
 */
export function readShellOptions(args: string[]): ShellOptions {
  let noexec = false;
  let commandString = false;
  let errexit: boolean | null = null;
  let i = 0;
  while (i < args.length) {
    const w = stripQuotes(args[i] ?? "");
    if (w === "--" || w === "-") {
      i++;
      break;
    }
    if (w.startsWith("--")) {
      if (w === "--noexec") noexec = true;
      i += SHELL_LONG_VALUE_OPTIONS.has(w) ? 2 : 1;
      continue;
    }
    if (!/^[-+][A-Za-z]+$/.test(w)) break;
    const on = w.startsWith("-");
    let consumed = 1;
    for (const letter of w.slice(1)) {
      if (letter === "e") errexit = on;
      else if (letter === "n") noexec = on;
      else if (letter === "c") commandString = commandString || on;
      else if (letter === "o" || letter === "O") {
        const name = stripQuotes(args[i + consumed] ?? "");
        if (letter === "o" && name === "noexec") noexec = on;
        if (letter === "o" && name === "errexit") errexit = on;
        consumed++;
      }
    }
    i += consumed;
  }
  return { noexec, commandString, operand: i, errexit };
}

/**
 * Drop here-document bodies (`<<EOF` ... `EOF`, `<<-EOF` with tab-stripped
 * delimiter lines): their text is data for a command, not commands. A `<<<`
 * here-string is not a here-document. An unterminated body drops the rest.
 */
function stripHeredocBodies(script: string): string {
  const out: string[] = [];
  let delimiter: string | null = null;
  let stripTabs = false;
  for (const line of script.split("\n")) {
    if (delimiter !== null) {
      const candidate = stripTabs ? line.replace(/^\t+/, "") : line;
      if (candidate === delimiter) delimiter = null;
      continue;
    }
    out.push(line);
    const m = /(?<!<)<<(-?)\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_]+))/.exec(
      line,
    );
    if (m) {
      stripTabs = m[1] === "-";
      delimiter = m[2] ?? m[3] ?? m[4] ?? "";
    }
  }
  return out.join("\n");
}

interface Frame {
  /** Status of the left operand when this compound was short-circuited. */
  skippedStatus: boolean | null;
  /** Possible exit statuses of completed if branches. */
  branchStatuses: Set<boolean | null>;
  /** The compound is entered regardless of any runtime chain condition. */
  entryCertain: boolean;
  /** Whether the construct itself is reached. */
  outer: boolean;
  /** Static truth of the condition (while: runs the body); null when unknown. */
  truth: boolean | null;
  branch: "cond" | "body" | "else";
  /** An earlier `if`/`elif` branch was statically taken, so later ones are not. */
  earlierTrue: boolean;
  /** `while` runs while true; `until` runs while false. */
  loop: "while" | "until" | null;
  /** A function body: never reached, ended by `}`. */
  fn: boolean;
  /** A function whose `{` is still to come on a later line. */
  awaitBrace: boolean;
  /** A `{ ... }` group, `( ... )` subshell or function body, not ended by `fi`/`done`. */
  brace: boolean;
  /** A `( ... )` subshell: an `exit` inside it does not end the script. */
  sub: boolean;
  /** Identity of this compound, for {@link ReachableCommand.groupSwallowed}. */
  id: number;
}

function frameLive(f: Frame): boolean {
  if (f.branch === "cond") return f.outer && !f.earlierTrue;
  if (f.branch === "body") {
    return f.outer && !f.earlierTrue && f.truth !== false;
  }
  return f.outer && !f.earlierTrue && f.truth !== true;
}

/**
 * Whether the frame's current branch runs every time the construct is reached
 * and an `exit` in it ends the script (false for a function body or subshell).
 */
function frameCertain(f: Frame): boolean {
  if (f.fn || f.sub || !f.entryCertain) return false;
  if (f.branch === "cond") return true;
  return f.branch === "body" ? f.truth === true : f.truth === false;
}

const FUNCTION_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*\(\)$/;

/**
 * A reachable command (see {@link reachableCommands}): its words, the separator
 * before it, the separator after it (`next`, `""` when it is the last command
 * of the body) and whether it sits in an `if`/`elif`/`while`/`until` condition.
 */
export interface ReachableCommand {
  words: string[];
  /** Separator before this command, as in {@link shellCommands}. */
  sep: string;
  /** Separator of the following command in the {@link shellCommands} list; `""` when last. */
  next: string;
  /** True when the command sits in an `if`/`elif`/`while`/`until` condition. */
  condition: boolean;
  /**
   * True when a failure of this command always ends the body with a failing
   * status through an explicit exit (see {@link failureExits}): `cmd || exit 1`
   * or `if ! cmd; then ...; exit 1; fi`.
   */
  failureExits: boolean;
  /**
   * True when the command sits inside a `{ }` group, `( )` subshell or other
   * compound (`if`/`fi`, a loop, `case`) whose closing word is followed by
   * `||`, `|` or `&`, or by `&&` with more of the body after that chain: the
   * compound's status, and with it this command's failure, can then be
   * swallowed one level out (`{ cmd; } || true`, `if x; then cmd; fi || true`,
   * `( cd x; cmd; cd .. ) | tee log`), and errexit is ignored inside a
   * compound on the left of `&&`, whatever separator follows the command
   * itself.
   */
  groupSwallowed: boolean;
}

/** Separators after a compound's closing word that can swallow its status. */
const GROUP_SWALLOWING_SEPARATORS = new Set(["||", "|", "&"]);

const CHAINING_SEPARATORS = new Set(["|", "&", "||", "&&"]);
/** Words that open a nested construct, which {@link failureExits} does not follow. */
const NESTED_OPENERS = new Set([
  "if",
  "while",
  "until",
  "for",
  "case",
  "select",
  "{",
  "(",
  "function",
]);

/** True when `words` is `exit N` with a non-zero integer N, or (when `bare`) a plain `exit`. */
function isFailingExit(words: string[], bare: boolean): boolean {
  if (stripQuotes(words[0] ?? "") !== "exit") return false;
  if (words.length === 1) return bare;
  return words.length === 2 && /^[1-9]\d*$/.test(stripQuotes(words[1] ?? ""));
}

/**
 * True when a failure of the listed command at `index` always ends the body
 * with a failing status, by one of two idioms:
 *
 * - `cmd || exit N` (N not 0, or a bare `exit`, which keeps the failing
 *   status), where nothing chains on after the `exit`;
 * - `if ! cmd; then ...; exit N; fi` (N not 0), where the `then` branch is
 *   flat (no nested construct) and runs the `exit` unconditionally (after `;`
 *   or a newline, with nothing chained after it).
 *
 * Any other form is false, so the caller falls back to its own rules.
 */
function failureExits(listed: ShellCommand[], index: number): boolean {
  const here = listed[index];
  const after = listed[index + 1];
  if (here === undefined || after === undefined) return false;
  if (after.sep === "||" && isFailingExit(after.words, true)) {
    // `! cmd || exit 1` inverts the status first: a failing cmd makes `!`
    // succeed, so the exit never runs.
    if (here.words.slice(0, commandIndex(here.words)).includes("!")) {
      return false;
    }
    const chained = listed[index + 2];
    return chained === undefined || !CHAINING_SEPARATORS.has(chained.sep);
  }
  if (here.words[0] !== "if" || here.words[1] !== "!") return false;
  if (CHAINING_SEPARATORS.has(after.sep) || after.words[0] !== "then") {
    return false;
  }
  let exits = false;
  for (let j = index + 1; j < listed.length; j++) {
    const entry = listed[j];
    if (entry === undefined) break;
    const words = j === index + 1 ? entry.words.slice(1) : entry.words;
    const head = words[0];
    if (head === undefined) continue;
    if (head === "fi" || head === "else" || head === "elif") return exits;
    if (NESTED_OPENERS.has(head) || words.includes("fi")) return false;
    const next = listed[j + 1];
    if (
      isFailingExit(words, false) && !CHAINING_SEPARATORS.has(entry.sep) &&
      (next === undefined || !CHAINING_SEPARATORS.has(next.sep))
    ) {
      exits = true;
    }
  }
  return false;
}

/**
 * The commands of a `run:` body that can run: it drops commands after an
 * unconditional `exit` or `set -n` / `set -o noexec`, behind `false &&` or `true ||`, in an `if`/`elif`/
 * `else` branch or a `while`/`until` body whose condition is statically false
 * (`false`, `! true`, `:` and `true` are the static commands), in a `{ }` or
 * `( )` group or other compound opened behind a skipped chain
 * (`false && { ...; }`, `true || (` ... `)`), in a function
 * body (the function may never be called) and in here-document bodies. An
 * `exit` that a condition guards (`[ -z "$X" ] && exit 0`, or inside an
 * unknown `if`) does not end the script here, so later commands still count;
 * one a static chain always reaches (`true && exit 0`, `false || exit 0`)
 * does.
 * Returns each reachable command with its words (keywords such as `then`
 * stripped), the separators around it and whether it is a condition. The
 * separators and `condition` come from the same `shellCommands` list the
 * reachability walk reads, so a caller can tell `cmd || true` from `cmd`.
 */
export function reachableCommands(script: string): ReachableCommand[] {
  const out: ReachableCommand[] = [];
  const stack: Frame[] = [];
  // For each emitted command, the compounds open around it; and for each
  // compound that closed, whether the separator after its closing word can
  // swallow its status (see ReachableCommand.groupSwallowed).
  const enclosing: number[][] = [];
  const swallowedFrames = new Set<number>();
  let nextFrameId = 0;
  let exited = false;
  let prev: boolean | null = null; // static status of the previous command

  const live = () =>
    !exited && (stack.at(-1) ? frameLive(stack.at(-1)!) : true);
  // Whether the command being read is skipped by the chain before it; a
  // compound it opens (`false && {`) inherits that, so its body never runs.
  let chainRuns: boolean | null = true;
  const push = (partial: Partial<Frame>) =>
    stack.push({
      outer: live() && chainRuns !== false,
      branchStatuses: new Set(),
      skippedStatus: chainRuns === false ? prev : null,
      entryCertain: chainRuns === true,
      truth: null,
      branch: "body",
      earlierTrue: false,
      loop: null,
      fn: false,
      awaitBrace: false,
      brace: false,
      sub: false,
      ...partial,
      id: nextFrameId++,
    });

  const { commands: listed, trailing } = shellCommandList(
    stripHeredocBodies(script),
  );
  for (const [index, { words: all, sep }] of listed.entries()) {
    let words = all;
    // Close the innermost compound, noting whether what follows its closing
    // word (`} || true`, `fi | tee`) can swallow its status.
    const pop = (): Frame | undefined => {
      const frame = stack.pop();
      const after = listed[index + 1]?.sep ??
        (trailing === "\n" ? "" : trailing);
      // `&&` after the closing word: errexit is ignored inside a compound on
      // the left of `&&`, so a failure in it reaches the body's status only
      // when the rest of the body is that `&&` chain to the end.
      const andWithMore = after === "&&" &&
        !listed.slice(index + 1).every((c) => c.sep === "&&");
      if (frame && (GROUP_SWALLOWING_SEPARATORS.has(after) || andWithMore)) {
        swallowedFrames.add(frame.id);
      }
      return frame;
    };
    // Short-circuit chains: `false && x` and `true || x` skip x, while
    // `true && x` and `false || x` always run it. `runs` is null when a
    // runtime status decides.
    const runs: boolean | null = sep === "&&"
      ? (prev === null ? null : prev)
      : sep === "||"
      ? (prev === null ? null : !prev)
      : true;
    const skipped = runs === false;
    chainRuns = runs;
    let closeAfter = false; // a one-line `( ... )` closes with its command
    // A skipped compound leaves its caller's status intact. Its body can
    // contain further groups, so recover that status from the matching frame.
    let closedStatus: boolean | null = null;
    // Structural keywords first; what is left is a plain command.
    while (words.length > 0) {
      // `(cd infra` opens a subshell exactly as `( cd infra` does; `((` is
      // arithmetic and `$(` a substitution, neither a subshell.
      const lead = words[0] ?? "";
      if (lead.length > 1 && lead.startsWith("(") && !lead.startsWith("((")) {
        words = ["(", lead.slice(1), ...words.slice(1)];
      }
      const w = words[0] ?? "";
      const top = stack.at(-1);
      if (top && (w === "fi" || w === "elif" || w === "else")) {
        if (frameLive(top)) top.branchStatuses.add(prev);
      }
      if (w === "fi" && top) {
        // With no matching branch and no else, Bash returns success.
        if (!top.earlierTrue && top.truth !== true && top.branch !== "else") {
          top.branchStatuses.add(true);
        }
        closedStatus = top.skippedStatus;
        if (top.entryCertain && top.branchStatuses.size === 1) {
          closedStatus = top.branchStatuses.values().next().value ?? null;
        }
        pop();
      } else if (w === "done" || w === "esac") {
        closedStatus = pop()?.skippedStatus ?? null;
      } else if (w === "}") {
        if (top?.brace) {
          // A brace group that ran returns its final command's status.
          closedStatus = top.skippedStatus ??
            (top.entryCertain && !top.fn && !top.sub ? prev : null);
          pop();
        }
      } else if (w === "if" || w === "while" || w === "until") {
        push({
          branch: "cond",
          loop: w === "if" ? null : w,
        });
      } else if (w === "elif" && top) {
        top.earlierTrue = top.earlierTrue || top.truth === true;
        top.branch = "cond";
        top.truth = null;
      } else if (w === "then" || w === "do") {
        if (top) top.branch = "body";
      } else if (w === "else") {
        if (top) top.branch = "else";
      } else if (w === "for" || w === "case" || w === "select") {
        push({});
        words = [];
        break;
      } else if (w === "{") {
        if (top?.awaitBrace) top.awaitBrace = false;
        else push({ truth: true, brace: true });
      } else if (w === "(") {
        push({ truth: true, brace: true, sub: true });
        if (words.length > 1 && words.at(-1) === ")") {
          closeAfter = true;
          words = words.slice(0, -1);
        }
      } else if (w === ")") {
        if (top?.sub) {
          closedStatus = top.skippedStatus;
          pop();
        }
      } else if (
        w === "function" || FUNCTION_NAME.test(w) || words[1] === "()"
      ) {
        const braceHere = words.includes("{");
        push({
          outer: false,
          truth: false,
          fn: true,
          brace: true,
          awaitBrace: !braceHere,
        });
        words = [];
        break;
      } else {
        break;
      }
      words = words.slice(1);
    }
    // A `)` that ends a later command of an open subshell closes it too:
    // `( cd infra; runner; cd .. )` and `(cd infra; runner; echo done)`. Only
    // an unbalanced `)` counts, so `$(date)` or a quoted `)` does not.
    if (!closeAfter && stack.at(-1)?.sub && words.length > 0) {
      const last = words.at(-1) ?? "";
      const opens = (last.match(/\(/g) ?? []).length;
      const closes = (last.match(/\)/g) ?? []).length;
      if (
        last.endsWith(")") && closes > opens && !/^["']/.test(last)
      ) {
        closeAfter = true;
        const trimmed = last.slice(0, -1);
        words = trimmed === "" ? words.slice(0, -1) : [
          ...words.slice(0, -1),
          trimmed,
        ];
      }
    }
    if (words.length === 0) {
      prev = closeAfter ? pop()?.skippedStatus ?? null : closedStatus;
      continue;
    }

    const frameOpen = stack.at(-1);
    if (!skipped) {
      const status = sep === "|" ? null : staticStatus(words);
      // When the left side is unknown, both paths can still agree:
      // X && false always fails, and X || true always succeeds.
      const skippedStatus = sep === "||";
      prev = runs === null && status !== skippedStatus ? null : status;
    }
    const reached = live() && !skipped;
    if (frameOpen?.branch === "cond") {
      // A skipped right operand leaves the chain's previous status intact.
      frameOpen.truth = prev === null || frameOpen.loop !== "until"
        ? prev
        : !prev;
    }
    if (reached) {
      out.push({
        words,
        sep,
        next: listed[index + 1]?.sep ?? (trailing === "\n" ? "" : trailing),
        condition: frameOpen?.branch === "cond",
        failureExits: failureExits(listed, index),
        groupSwallowed: false,
      });
      enclosing.push(stack.map((frame) => frame.id));
      const at = commandIndex(words);
      const head = stripQuotes(words[at] ?? "");
      const certain = runs === true && sep !== "|" && sep !== "&" &&
        stack.every(frameCertain);
      const stops = head === "exit" ||
        (head === "set" && readShellOptions(words.slice(at + 1)).noexec);
      if (stops && certain) exited = true;
    }
    if (closeAfter) prev = pop()?.skippedStatus ?? prev;
  }
  for (const [k, cmd] of out.entries()) {
    cmd.groupSwallowed = (enclosing[k] ?? []).some((id) =>
      swallowedFrames.has(id)
    );
  }
  return out;
}
