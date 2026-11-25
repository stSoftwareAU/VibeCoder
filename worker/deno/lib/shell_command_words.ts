/**
 * Shell command-word helpers for the AWS Emulator CI checks (Issue #5110,
 * PR #5276 review).
 *
 * These find command words in a GitHub Actions `run:` body; they are not a
 * shell parser. `shellSegments` splits a body into commands, `commandIndex`
 * finds a command's word, and `reachableCommands` drops commands that cannot
 * run (after an unconditional `exit` or `set -n`, behind `false &&`, in a branch or loop
 * whose condition is statically false, in any function body, or inside
 * a here-document), and strips a `case` arm's pattern (with its optional `(`
 * and `|` alternatives) so the command word is the arm's first command (Issue
 * #5382). It also reports each reachable command's separators and
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
 * (`X="a b"` is one word), and an unquoted newline or `;`/`|`/`&` starts a
 * new command.
 *
 * Outside quotes a backslash escapes the next character, and the word
 * keeps the escape as written (`\\`, `\"`, `\;`). An odd run of backslashes
 * outside quotes before a newline continues the line: the newline is removed
 * with no blank inserted, so `ab\` + newline + `cd` is the word `abcd`, and leading blanks on
 * the next line still split. An even run is escaped backslashes, so the newline
 * ends the command (`a \\` + newline + `b` is two commands). Inside double
 * quotes a backslash continues the line before a newline, escapes `\`, `"`,
 * `$` or a backtick, and is otherwise literal. ANSI-C `$'…'` quoting opens
 * outside other quotes, including across unquoted line continuations,
 * consumes backslash-escaped characters together and
 * closes only on an unescaped apostrophe. Its raw spelling (including escapes
 * and newlines) is kept, without decoding; adjacent quoted and plain fragments
 * remain one word. A `#` that starts a word outside quotes is a
 * comment that ends at its physical newline, so a backslash at its end is
 * comment text and the next line is its own command.
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
  const text = script;
  // The length of the line break at `at` (`\n` or `\r\n`), 0 when none is.
  const newlineLength = (at: number): number =>
    text.startsWith("\r\n", at) ? 2 : text.startsWith("\n", at) ? 1 : 0;
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
    } else if (next !== "\n" && !(sep === "&" && next === ";;")) {
      sep = next;
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quote === "$'") {
      word += ch;
      if (ch === "\\" && i + 1 < text.length) {
        word += text.charAt(++i);
      } else if (ch === "'") {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      // Single quotes are literal, a backslash-newline included.
      word += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") {
        const lineBreak = newlineLength(i + 1);
        const escaped = text.charAt(i + 1);
        if (lineBreak > 0) {
          i += lineBreak; // a continuation inside double quotes is removed
        } else if (["\\", '"', "$", "`"].includes(escaped)) {
          word += ch + escaped;
          i++;
        } else {
          word += ch;
        }
        continue;
      }
      word += ch;
      if (ch === '"') quote = null;
      continue;
    }
    // Outside quotes a backslash escapes the next character. A
    // backslash-newline is a continuation: removed, with no blank inserted.
    if (ch === "\\") {
      const lineBreak = newlineLength(i + 1);
      if (lineBreak > 0) {
        i += lineBreak;
        continue;
      }
      const escaped = text.charAt(i + 1);
      word += ch + escaped; // a lone trailing backslash is appended alone
      inWord = true;
      if (escaped !== "") i++;
      continue;
    }
    if (ch === "$") {
      // Unquoted continuations disappear before Bash recognises the opener.
      let opener = i + 1;
      while (text.charAt(opener) === "\\") {
        const lineBreak = newlineLength(opener + 1);
        if (lineBreak === 0) break;
        opener += 1 + lineBreak;
      }
      // `$$` is the process-ID parameter and is read as one unit first, so
      // the `'` in `$$'…'` opens an ordinary single-quoted word, while
      // `$$$'…'` still opens ANSI-C at its third `$` (PR #5610 review).
      if (text.charAt(opener) === "$") {
        word += "$$";
        inWord = true;
        i = opener;
        continue;
      }
      if (text.charAt(opener) === "'") {
        quote = "$'";
        word += "$'";
        inWord = true;
        i = opener;
        continue;
      }
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
    // An `&` in a redirection is part of the word, not a background `&`:
    // `2>&1`, `>&2`, `<&3`, `&>log`, `&>>log` (PR #5332 review).
    if (
      ch === "&" &&
      ((inWord && /[<>]$/.test(word)) ||
        (text.charAt(i + 1) === ">" && text.charAt(i - 1) !== "&"))
    ) {
      word += ch;
      inWord = true;
      continue;
    }
    // `|&` pipes stderr too (`2>&1 |`): a pipe for this walk.
    if (ch === "|" && text.charAt(i + 1) === "&") {
      endCommand("|");
      i++;
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
 * Index of the command word. Skips shell reserved words, `sudo`, `exec`,
 * leading `VAR=value` words and the wrappers `time` (with `-p`),
 * `nice` (with `-n N` or `-N`), `timeout` (with its options and its duration
 * word) and `command`. A `VAR=value` word counts only with an unquoted name
 * (bash's rule, so `"X=1" cmd` runs a command named `X=1`). `env` is skipped
 * with each operand after it that contains `=` once quotes are removed
 * (`env "X"=1 cmd`), as GNU and BSD `env` read them. A `VAR=value` word (or
 * `env` operand) whose value opens a `$( … )`, `$(( … ))` or backtick
 * substitution split at blanks is skipped together with the words up to the
 * one that closes it (quote-aware), so `X=$(cat v) cmd` finds `cmd`; one never
 * closed in the command's words leaves no command word (`words.length`), and
 * so does an unclosed `(` that opens no substitution (`X=${Y:-(} cmd`). A
 * substitution holding a `;`, `|`, `&`, `&&`, `||` or newline is still split
 * into separate commands by {@link shellCommands}, so `X=$(a; b) cmd` finds
 * `b)`. The scan stops at an option word (`-i`, `--split-string=echo`):
 * `env -S`/`--split-string` makes its value the command, so the option stays
 * the command word and fails closed. `command -v`/`-V` only looks a command
 * up, so it stops the scan at `command` itself. Returns `words.length` when
 * none is found. It does not skip a `case` arm's pattern (`test) cmd`):
 * {@link reachableCommands} removes the pattern before callers read the
 * command word, because only the walk knows a `case` is open (Issue #5382).
 */
export function commandIndex(words: string[]): number {
  return commandScan(words).index;
}

/**
 * The words in front of the command word that the shell reads as reserved or
 * prefix words, without the words inside an assignment's substitution (so
 * `X=$(test ! -f v) cmd` has no `!` prefix).
 */
export function commandPrefixWords(words: string[]): string[] {
  return commandScan(words).prefix;
}

/** These shell constructs can contain a closing parenthesis that belongs to
 * the construct itself. The word scan cannot locate the command after it.
 */
function ambiguousSubstitutionWord(word: string): boolean {
  return word.includes("$'") || /\$\{[^{}]*[()]/.test(word) ||
    /(?:^|\$\()case$/.test(word);
}

/**
 * Index past the assignment at `words[start]` and the following words its
 * unclosed `$( … )`, `(` or backtick substitution spans. Each skipped
 * following word's index is added to `inner`.
 */
function skipAssignment(
  words: string[],
  start: number,
  inner: Set<number>,
): number {
  const first = words[start] ?? "";
  let open = parenBalance(first).delta;
  // A `(` that opens no substitution (`${Y:-(}`) is not a span the shell
  // closes later, so nothing after it is read as the command (Issue #5378).
  if (
    open > 0 && (hasPlainOpenParen(first) || ambiguousSubstitutionWord(first))
  ) {
    return words.length;
  }
  let ticks = backtickCount(first);
  let i = start + 1;
  while ((open > 0 || ticks % 2 === 1) && i < words.length) {
    const word = words[i] ?? "";
    if (ambiguousSubstitutionWord(word)) return words.length;
    open += parenBalance(word).delta;
    ticks += backtickCount(word);
    inner.add(i);
    i++;
  }
  return i;
}

/** The {@link commandIndex} scan: the index and the prefix words before it. */
function commandScan(words: string[]): { index: number; prefix: string[] } {
  const inner = new Set<number>();
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? "";
    if (SHELL_PREFIX_WORDS.has(w)) {
      i++;
    } else if (SHELL_ASSIGNMENT.test(w)) {
      i = skipAssignment(words, i, inner);
    } else if (w === "env") {
      i++;
      while (i < words.length && isEnvAssignment(words[i] ?? "")) {
        i = skipAssignment(words, i, inner);
      }
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
  return {
    index: i,
    prefix: words.slice(0, i).filter((_, k) => !inner.has(k)),
  };
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
  const { index, prefix } = commandScan(words);
  return prefix.some((w) => STATUS_ALTERING_PREFIX_WORDS.has(w)) ? -1 : index;
}

/**
 * True when `env` reads `word` as a `NAME=value` operand: it contains `=` once
 * quotes are removed and is not an option (does not start with `-`).
 */
function isEnvAssignment(word: string): boolean {
  const unquoted = removeQuotes(word);
  return !unquoted.startsWith("-") && unquoted.includes("=");
}

/** Shell quote removal on a word as {@link shellCommands} returns it; `$…` is not expanded. */
export function removeQuotes(word: string): string {
  let out = "";
  let quote = "";
  for (let i = 0; i < word.length; i++) {
    const ch = word.charAt(i);
    if (quote === "'") {
      if (ch === "'") quote = "";
      else out += ch;
    } else if (ch === "\\") {
      const next = word.charAt(i + 1);
      if (quote === '"' && !["\\", '"', "$", "`"].includes(next)) out += ch;
      else {
        out += next;
        i++;
      }
    } else if (ch === quote) {
      quote = "";
    } else if (quote === "" && (ch === "'" || ch === '"')) {
      quote = ch;
    } else {
      out += ch;
    }
  }
  return out;
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
  const { index: i, prefix } = commandScan(words);
  const head = stripQuotes(words[i] ?? "");
  const base = head === "true" || head === ":"
    ? true
    : head === "false"
    ? false
    : null;
  if (base === null) return null;
  const negations = prefix.filter((w) => w === "!").length;
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
  /**
   * An earlier `if`/`elif` test was decided at run time, so a later `elif` or
   * `else` branch runs only when that test fails (PR #5332 review).
   */
  earlierUnknown: boolean;
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
  /**
   * A `$(` substitution or `(` array literal left open at a line end, ended
   * by the `)` that balances it (PR #5332 review). It is also `sub`, and no
   * command inside it is credited.
   */
  subst: boolean;
  /** A `case` statement, whose patterns end in `)`. */
  kase: boolean;
  /**
   * A `case` whose next command starts with an arm's pattern (its header ended
   * in `in`, or an earlier pattern alternative was followed by `|`).
   */
  casePatternNext: boolean;
  /** Identity of this compound, for {@link ReachableCommand.groupSwallowed}. */
  id: number;
  /** A `for`, `select`, `while` or `until` loop. */
  iterates: boolean;
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
 * and an `exit` in it ends the script (false for a function body, and for a
 * subshell unless `allowSub` is set).
 */
function frameCertain(f: Frame, allowSub = false): boolean {
  if (f.fn || (f.sub && !allowSub) || !f.entryCertain) return false;
  if (f.earlierUnknown) return false;
  if (f.branch === "cond") return true;
  return f.branch === "body" ? f.truth === true : f.truth === false;
}

/** Ids of the subshell frames in `stack` that are opened inside a loop body. */
function subshellsInsideLoops(stack: Frame[]): number[] {
  const ids: number[] = [];
  let looped = false;
  for (const frame of stack) {
    if (frame.sub && looped) ids.push(frame.id);
    if (frame.iterates) looped = true;
  }
  return ids;
}

/** Ids of the subshell frames in `stack` that are opened inside a test. */
function subshellsInsideConditions(stack: Frame[]): number[] {
  const ids: number[] = [];
  let inTest = false;
  for (const frame of stack) {
    if (frame.sub && inTest) ids.push(frame.id);
    if (!frame.sub && frame.branch === "cond") inTest = true;
  }
  return ids;
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
  /**
   * True when the command sits inside a compound whose closing word is
   * followed by `&&` (`{ cmd; other; } && echo ok`): Bash ignores errexit for
   * every command in it, so a failure stops the body only through the
   * compound's own status (PR #5332 review).
   */
  errexitIgnored: boolean;
  /**
   * True when the command sits in a `for`, `select`, `while` or `until` body:
   * the loop returns the status of the last command it ran, so a failure in an
   * earlier pass is lost when a later one succeeds (PR #5332 review).
   */
  inLoop: boolean;
  /**
   * Ids of the `( )` subshells and substitutions around the command that sit
   * inside a loop body (`for d in a b; do ( cmd ); done`): such a subshell's
   * failure is lost when a later pass succeeds. A loop inside the subshell
   * (`( set -e; for d in a b; do cmd; done )`) does not list it, because
   * errexit inside the subshell can still end it on the first failing pass.
   */
  subshellsInLoop: number[];
  /**
   * Ids of the `( )` subshells and substitutions around the command that are
   * opened inside an `if`, `elif`, `while` or `until` test
   * (`if ( cmd || exit 1 ); then …`): such a subshell's failure only makes
   * the test false, and errexit is ignored in a test (PR #5332 review round
   * 10). A test inside the subshell (`( if ! cmd; then exit 1; fi )`) does
   * not list it.
   */
  subshellsInCondition: number[];
  /**
   * True when the command sits inside a parenthesis or backtick substitution
   * opened earlier on its line, or by its own words before the command word,
   * that the walk tracks no frame for (`time ( cd x; cmd )`, `! ( cmd )`,
   * `X=$( cmd; echo done )`, `X=$(cd x && cmd)`, `echo $(cmd)`): its status is
   * an argument, a negation or a substitution's, so it is never credited, and
   * a `set` in it does not change errexit outside (PR #5332 review rounds 11
   * and 12).
   */
  inUntrackedParen: boolean;
  /**
   * True when the command runs every time the body reaches it: no run-time
   * `&&`/`||` chain, `if`/`elif`/`else` branch, loop body or `case` arm decides
   * it, and the separator before it is not `|` and the one after it is not `|`
   * or `&` (`set -e | cat`, `echo hi | set -e` and `set -e &` run in a
   * subshell; `sleep 30 & set -e` runs the `set` in the current shell, since
   * only the command before the `&` is backgrounded). An `elif` or `else`
   * branch is certain only when every earlier test of its `if` is decided
   * statically. A `( )` subshell around it does
   * not clear this (`( set -e; cmd )` runs the `set` whenever the subshell
   * runs). A `set -e` that is not certain turns errexit on only when its
   * condition holds, so the walk does not credit it (PR #5332 review).
   */
  certain: boolean;
  /**
   * Ids of the `( )` subshells and substitutions open around the command,
   * innermost last: a `set` inside one changes the options only until it
   * closes (PR #5332 review).
   */
  subshells: number[];
}

/** Separators after a compound's closing word that can swallow its status. */
const GROUP_SWALLOWING_SEPARATORS = new Set(["||", "|", "&"]);

const CHAINING_SEPARATORS = new Set(["|", "&", "||", "&&"]);
/**
 * Words that open a nested construct, which {@link failureExits} does not
 * follow. A `(` is judged by its parenthesis balance instead.
 */
const NESTED_OPENERS = new Set([
  "if",
  "while",
  "until",
  "for",
  "case",
  "select",
  "{",
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
 *
 * `hereWords` replaces the listed command's own words when the walk removed a
 * `case` arm's pattern from them (`test) ! cmd || exit 1`), so the idioms are
 * judged on the command and not on `test)` (Issue #5382).
 */
function failureExits(
  listed: ShellCommand[],
  index: number,
  closePending: number | null,
  hereWords?: string[],
): boolean {
  const listedHere = listed[index];
  const listedAfter = listed[index + 1];
  if (listedHere === undefined || listedAfter === undefined) return false;
  // A one-line subshell's `(` and `)` sit in the listed words
  // (`( if ! cmd; …`, `cmd || exit 1 )`, `exit 1)`); they are not part of
  // the command or the exit (PR #5332 review round 10). The `)` is dropped
  // only when it closes the tracked `( )` subshell open around the command
  // (`closePending` is the line's open-parenthesis count then, null when the
  // innermost frame is not such a subshell), so an exit that ends a nested
  // subshell or substitution is never read as the idiom (round 11).
  const here = {
    ...listedHere,
    words: withoutSubshellOpen(hereWords ?? listedHere.words),
  };
  const after = {
    ...listedAfter,
    words: closePending === null
      ? listedAfter.words
      : withoutSubshellClose(listedAfter.words, closePending),
  };
  if (after.sep === "||" && isFailingExit(after.words, true)) {
    // `! cmd || exit 1` inverts the status first: a failing cmd makes `!`
    // succeed, so the exit never runs.
    if (commandPrefixWords(here.words).includes("!")) {
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
  // Unquoted parentheses opened in the branch and not yet closed: an exit read
  // while one is open ends only that subshell or substitution (round 11). A
  // parenthesis that closes inside its own word or command (`"$(date)"`,
  // `$(pwd)/log`, `$((n / 60))`) leaves the balance at zero (round 12).
  let open = 0;
  // Backticks seen in the branch, modulo 2: an exit read while one is open
  // ends only the backtick substitution (round 13).
  let ticks = 0;
  for (let j = index + 1; j < listed.length; j++) {
    const entry = listed[j];
    if (entry === undefined) break;
    const own = j === index + 1 ? entry.words.slice(1) : entry.words;
    // `fi)` closes the `if` and then a subshell around it.
    const words = /^fi\)+$/.test(own[0] ?? "") ? ["fi", ...own.slice(1)] : own;
    const head = words[0];
    if (head === undefined) continue;
    if (head === "fi" || head === "else" || head === "elif") return exits;
    if (NESTED_OPENERS.has(head) || words.includes("fi")) return false;
    const next = listed[j + 1];
    if (
      isFailingExit(words, false) && !CHAINING_SEPARATORS.has(entry.sep) &&
      (next === undefined || !CHAINING_SEPARATORS.has(next.sep))
    ) {
      if (open > 0 || ticks % 2 === 1) return false;
      exits = true;
    }
    for (const word of words) {
      open = Math.max(0, open + parenBalance(word).delta);
      ticks += backtickCount(word);
    }
  }
  return false;
}

/**
 * `words` without the leading `(` of a subshell opened on the same line
 * (`(`, `( (`, or a `(` glued to the first word, as in `(if`).
 */
function withoutSubshellOpen(words: string[]): string[] {
  const out = [...words];
  while (
    out.length > 0 && out[0]?.startsWith("(") && !out[0].startsWith("((")
  ) {
    const rest = (out[0] ?? "").slice(1);
    if (rest === "") out.shift();
    else out[0] = rest;
  }
  return out;
}

/**
 * `words` without a closing `)` that ends a subshell opened before them, and
 * any redirections after it (`exit 1 )`, `exit 1)`, `fi ) >log`), as
 * {@link subshellCloseIndex} reads it.
 */
function withoutSubshellClose(words: string[], pending: number): string[] {
  const at = subshellCloseIndex(words, pending);
  if (at === -1) return words;
  const word = (words[at] ?? "").replace(/\)+$/, "");
  return word === "" ? words.slice(0, at) : [...words.slice(0, at), word];
}

/**
 * The unquoted parenthesis balance of a word (`(` +1, `)` -1), and whether its
 * last character is an unquoted `)`.
 */
function parenBalance(word: string): { delta: number; endsClose: boolean } {
  let quote = "";
  let delta = 0;
  let endsClose = false;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    endsClose = false;
    if (quote !== "") {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === "\\") {
      i++;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "(") {
      delta++;
    } else if (ch === ")") {
      delta--;
      endsClose = true;
    }
  }
  return { delta, endsClose: quote === "" && endsClose };
}

/**
 * Whether an assignment word holds an unquoted, unescaped `(` that opens no
 * substitution: not `$(`, `$((`, `<(`, `>(` or the `(` of an array value
 * right after the first `=` (`X=(a b)`).
 */
function hasPlainOpenParen(word: string): boolean {
  let quote = "";
  let prev = "";
  let prev2 = "";
  let valueStart = -1;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i] ?? "";
    if (quote !== "") {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = "";
      prev2 = prev;
      prev = "";
      continue;
    }
    if (ch === "\\") {
      i++;
      prev2 = prev;
      prev = "";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "=" && valueStart < 0) {
      valueStart = i + 1;
    } else if (ch === "(") {
      const opens = prev === "$" || prev === "<" || prev === ">" ||
        i === valueStart || (prev === "(" && prev2 === "$");
      if (!opens) return true;
    }
    prev2 = prev;
    prev = ch;
  }
  return false;
}

/** The backticks of a word outside single quotes and not backslash-escaped. */
function backtickCount(word: string): number {
  let quote = "";
  let count = 0;
  for (let i = 0; i < word.length; i++) {
    const ch = word[i];
    if (quote === "'") {
      if (ch === "'") quote = "";
    } else if (ch === "\\") {
      i++;
    } else if (ch === "'" && quote === "") {
      quote = "'";
    } else if (ch === '"') {
      quote = quote === '"' ? "" : '"';
    } else if (ch === "`") {
      count++;
    }
  }
  return count;
}

/** A redirection operator alone (`>`, `2>>`, `&>`, `<`), its target in the next word. */
const REDIRECT_OPERATOR = /^(?:\d*(?:>>?|<|<>|>\||<<<)|&>>?)$/;
/** A redirection with its target attached (`>log`, `2>&1`, `&>log`, `</dev/null`). */
const REDIRECT_ATTACHED = /^(?:\d*(?:>>?|<|<>|>\||<<<)|&>>?)[^<>]/;

/**
 * Whether `words[from..]` is only redirections, each an attached one or an
 * operator and its target: `) 2>&1`, `) > log 2>&1` and `) </dev/null` are a
 * close followed by redirections (PR #5332 review).
 */
function redirectionsFrom(words: string[], from: number): boolean {
  for (let i = from; i < words.length; i++) {
    const w = words[i] ?? "";
    if (REDIRECT_OPERATOR.test(w)) {
      if (i + 1 >= words.length) return false;
      i++;
    } else if (!REDIRECT_ATTACHED.test(w)) {
      return false;
    }
  }
  return true;
}

/**
 * Index of the word whose unquoted `)` closes the open subshell, or -1: the
 * last word before any trailing redirections ends in an unquoted `)`, and
 * across the words up to it, outside quotes, there is one more `)` than `(`
 * (PR #5332 review). So `done)`, `"done")`, `echo 'a')` and `done) 2>&1`
 * close it, while `cd $(git rev-parse --show-toplevel)`, `args=(--foo bar)`
 * and `$(date)` do not. `pending` is the balance of `$(` or `(` opened by
 * earlier commands on the same line (`$(ls | wc -l)` is split at the `|`),
 * which this command's `)` closes first.
 */
function subshellCloseIndex(words: string[], pending = 0): number {
  for (let j = words.length - 1; j >= 0; j--) {
    if (!parenBalance(words[j] ?? "").endsClose) continue;
    if (!redirectionsFrom(words, j + 1)) return -1;
    let depth = pending;
    for (const word of words.slice(0, j + 1)) {
      depth += parenBalance(word).delta;
    }
    return depth < 0 ? j : -1;
  }
  return -1;
}

/** Words that open or continue a compound; dropped inside an untracked `$( )`. */
const UNTRACKED_HEAD_KEYWORDS = new Set([
  "if",
  "elif",
  "while",
  "until",
  "then",
  "do",
  "else",
  "{",
]);
/** Words that open a compound whose header takes the rest of the command. */
const UNTRACKED_HEADER_KEYWORDS = new Set(["for", "case", "select"]);

/**
 * Removes a `case` arm's pattern from the start of a command's words: an
 * optional `(`, then the pattern word ending in `)` (`test)`) or followed by a
 * lone `)` (`test )`). A pattern alternative followed by `|` (`nextSep`) has
 * its `)` in the next listed command, so `more` is true and no words remain.
 * `esac` and anything else that is not a pattern comes back unchanged (the same
 * array) with `more` false (Issue #5382).
 */
function afterCasePattern(
  words: string[],
  nextSep: string,
): { words: string[]; more: boolean } {
  if (/^esac\)*$/.test(words[0] ?? "")) return { words, more: false };
  let rest = words;
  const lead = rest[0] ?? "";
  if (lead === "(") rest = rest.slice(1);
  else if (lead.length > 1 && lead.startsWith("(") && !lead.startsWith("((")) {
    rest = [lead.slice(1), ...rest.slice(1)];
  }
  const first = rest[0] ?? "";
  const balance = parenBalance(first);
  if (first !== "" && balance.endsClose && balance.delta < 0) {
    return { words: rest.slice(1), more: false };
  }
  if (first !== "" && rest[1] === ")") {
    return { words: rest.slice(2), more: false };
  }
  if (rest.length === 1 && nextSep === "|") return { words: [], more: true };
  return { words, more: false };
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
 * stripped, and a `case` arm's pattern with its optional `(` and `|`
 * alternatives; a fall-through arm after `;&` or `;;&` keeps its pattern,
 * because that separator cannot be told from a backgrounded command, so it
 * stays uncredited: Issue #5382), the separators around it and whether it is a condition. The
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
  // Compounds whose closing word is followed by `&&` (errexit ignored inside).
  const andLeftFrames = new Set<number>();
  let nextFrameId = 0;
  let strayClose = false;
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
      earlierUnknown: false,
      loop: null,
      fn: false,
      awaitBrace: false,
      brace: false,
      sub: false,
      subst: false,
      kase: false,
      casePatternNext: false,
      iterates: false,
      ...partial,
      id: nextFrameId++,
    });

  // Whether the closing word `keyword` closes the innermost frame: `fi` an
  // `if`, `done` a loop, `esac` a `case`, `}` a brace group or function body.
  // A closer with no frame of its own kind open (a `subst` frame innermost, or
  // none) is a plain word and ends nothing (PR #5332 review round 14).
  const closesInnermost = (keyword: string): boolean => {
    const innermost = stack.at(-1);
    if (!innermost) return false;
    return keyword === "fi"
      ? !innermost.sub && !innermost.brace && !innermost.iterates &&
        !innermost.kase
      : keyword === "done"
      ? innermost.iterates
      : keyword === "esac"
      ? innermost.kase
      : innermost.brace && !innermost.sub;
  };
  // Whether `keyword` closes the innermost frame and each of `parens` then
  // closes a tracked `( )` subshell frame beneath it.
  const closesInsideSubshell = (keyword: string, parens: string): boolean => {
    if (!closesInnermost(keyword)) return false;
    for (let depth = 1; depth <= parens.length; depth++) {
      const frame = stack.at(-1 - depth);
      if (!frame?.sub || frame.subst) return false;
    }
    return true;
  };

  const { commands: listed, trailing } = shellCommandList(
    stripHeredocBodies(script),
  );
  // Parentheses opened by earlier commands of the current line and not yet
  // closed (a `$(` split by the command list at a `|`, `;` or `&&`).
  let linePending = 0;
  // Backticks of the earlier commands, modulo 2: odd while a backtick
  // substitution is open, across lines.
  let lineTicks = 0;
  // `case` statements opened inside an untracked substitution and not yet
  // closed by their `esac`, and whether the next command is their first arm's
  // pattern (the header ended at `in`).
  let untrackedCases = 0;
  let patternNext = false;
  for (const [index, { words: all, sep: listedSep }] of listed.entries()) {
    let words = all;
    let sep = listedSep;
    const pendingBefore = linePending;
    const untrackedHere = pendingBefore > 0 || lineTicks % 2 === 1;
    // The words the failure-exit idioms read, once a `case` pattern is removed.
    let hereWords: string[] | undefined;
    // The command after a `case` arm's `;;` (or the first after `in`) starts
    // with that arm's pattern. Only `;;` marks an arm: `;&` and `;;&` read as
    // `&`, which cannot be told from a backgrounded command, so those arms
    // stay uncredited (fails closed).
    const caseFrame = stack.at(-1);
    if (
      !untrackedHere && caseFrame?.kase &&
      (caseFrame.casePatternNext || sep === ";;")
    ) {
      const result = afterCasePattern(words, listed[index + 1]?.sep ?? "");
      caseFrame.casePatternNext = result.more;
      if (result.words !== words) {
        words = result.words;
        hereWords = words;
        // An alternative's command (`b) cmd` after `a|`) starts the arm.
        if (sep === "|") sep = ";;";
      }
    }
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
      if (frame && after === "&&") andLeftFrames.add(frame.id);
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
    // A command that starts inside a `$( … )`, `$(( … ))` or backtick
    // substitution the walk tracks no frame for (an earlier command of the
    // line left it open): none of its compounds is tracked, because their
    // closers are not matched to them and the `)` after one belongs to the
    // substitution. Its openers and branch words are dropped with no effect on
    // the frame stack; a closer, `(` or `)` stays a plain word for the
    // parenthesis balance (round 14).
    let droppedParens = 0;
    let droppedTicks = 0;
    // The first word of a `case` arm inside an untracked `$( … )` is a pattern
    // whose `)` closes nothing (`a) echo 1 ;; b) echo 2 ;; esac)`).
    const patternHere = untrackedHere && untrackedCases > 0 &&
      (sep === ";;" || patternNext) && !/^esac\)*$/.test(all[0] ?? "");
    patternNext = false;
    while (words.length > 0) {
      if (untrackedHere) {
        const first = words[0] ?? "";
        if (UNTRACKED_HEAD_KEYWORDS.has(first)) {
          words = words.slice(1);
          continue;
        }
        if (UNTRACKED_HEADER_KEYWORDS.has(first)) {
          // The header is dropped, but a `$(` or backtick it opens (`for f in
          // $(ls | sort)`) still counts for the substitution balance, and a
          // `case` pattern's `)` closes nothing (round 15).
          for (const word of words) {
            droppedParens += first === "case"
              ? Math.max(0, parenBalance(word).delta)
              : parenBalance(word).delta;
            droppedTicks += backtickCount(word);
          }
          if (first === "case") {
            untrackedCases++;
            patternNext = words.at(-1) === "in";
          }
          words = [];
          break;
        }
        break;
      }
      // `(cd infra` opens a subshell exactly as `( cd infra` does; `((` is
      // arithmetic and `$(` a substitution, neither a subshell.
      const lead = words[0] ?? "";
      if (lead.length > 1 && lead.startsWith("(") && !lead.startsWith("((")) {
        words = ["(", lead.slice(1), ...words.slice(1)];
      }
      // `fi)`, `done)`, `esac)` and `})` close the compound and then a
      // subshell around it, as `fi )` does, but only when the innermost frame
      // is the compound the keyword closes and a tracked `( )` subshell is
      // open around it for each `)`. Otherwise the `)` closes a `$( ... )`
      // the walk tracks no frame for (`X=$(for d in a b; do echo $d; done)`),
      // or one opened earlier on this line (`linePending`, as in `( for …; do
      // X=$(for …; done); …`), and the word stays whole so the parenthesis
      // balance closes it (PR #5332 review rounds 11 to 14). Commands that
      // start inside such a `$( … )` never reach this point: `untrackedHere`
      // above leaves their compounds out of the frame stack.
      const closing = /^(fi|done|esac|\})(\)+)$/.exec(words[0] ?? "");
      if (
        closing && linePending === 0 &&
        closesInsideSubshell(closing[1] ?? "", closing[2] ?? "")
      ) {
        words = [
          closing[1] ?? "",
          ...Array.from({ length: closing[2]?.length ?? 0 }, () => ")"),
          ...words.slice(1),
        ];
      }
      const w = words[0] ?? "";
      // A closer with no open frame of its own kind is a plain word.
      if (
        (w === "fi" || w === "done" || w === "esac" || w === "}") &&
        !closesInnermost(w)
      ) {
        break;
      }
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
          iterates: w !== "if",
        });
      } else if (w === "elif" && top) {
        top.earlierTrue = top.earlierTrue || top.truth === true;
        top.earlierUnknown = top.earlierUnknown || top.truth === null;
        top.branch = "cond";
        top.truth = null;
      } else if (w === "then" || w === "do") {
        if (top) top.branch = "body";
      } else if (w === "else") {
        if (top) {
          top.earlierUnknown = top.earlierUnknown || top.truth === null;
          top.branch = "else";
        }
      } else if (w === "for" || w === "select") {
        push({ iterates: true });
        words = [];
        break;
      } else if (w === "case") {
        push({ kase: true });
        const frame = stack.at(-1);
        if (words[2] !== "in") {
          words = [];
          break;
        }
        if (words.length === 3) {
          if (frame) frame.casePatternNext = true;
          words = [];
          break;
        }
        // The first arm shares the line (`case $1 in a) cmd ;; esac`).
        const result = afterCasePattern(
          words.slice(3),
          listed[index + 1]?.sep ?? "",
        );
        if (frame) frame.casePatternNext = result.more;
        words = result.words;
        hereWords = words;
        continue;
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
        } else if (!stack.some((frame) => frame.kase)) {
          // A `)` with no open subshell: the walk lost track of the
          // parentheses, so nothing in the body is credited (fails closed).
          strayClose = true;
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
    // Redirections after the `)` belong to the subshell and are dropped:
    // `( runner; echo done ) 2>&1 | tee log` (PR #5332 review).
    if (!closeAfter && stack.at(-1)?.sub && words.length > 0) {
      const at = subshellCloseIndex(words, linePending);
      if (at !== -1) {
        closeAfter = true;
        const trimmed = (words[at] ?? "").slice(0, -1);
        words = trimmed === "" ? words.slice(0, at) : [
          ...words.slice(0, at),
          trimmed,
        ];
      }
    }
    // A `$(` or `(` left open at the line end (`VERSION=$(`, `args=(`)
    // opens a frame that the balancing `)` closes, so that `)` does not close
    // an enclosing subshell instead.
    // The balance is carried across the commands of one line, because the
    // command list splits at a `|`, `;` or `&&` inside `$( … )`
    // (`if [ $(ls | wc -l) -gt 0 ]`): only a parenthesis still open at the
    // line's end opens a frame (PR #5332 review).
    // A parenthesis or backtick still open when this command's own word is
    // reached (`X=$( runner; …`, `time ( runner )`, `! ( runner )`): the
    // command runs inside it, with no frame to judge it by (round 12).
    const prefixWords = words.slice(0, commandIndex(words));
    let openAtCommand = pendingBefore;
    let ticksAtCommand = lineTicks;
    for (const word of prefixWords) {
      openAtCommand += parenBalance(word).delta;
      ticksAtCommand += backtickCount(word);
    }
    const inUntrackedParen = openAtCommand > 0 || ticksAtCommand % 2 === 1;
    // A backtick substitution may span lines, so the parity is carried to the
    // closing backtick, and every command up to it is untracked (round 13).
    for (const word of words) lineTicks += backtickCount(word);
    lineTicks = (lineTicks + droppedTicks) % 2;
    if (untrackedCases > 0 && /^esac\)*$/.test(all[0] ?? "")) untrackedCases--;
    let opensSubst = false;
    if (closeAfter) {
      linePending = 0;
    } else {
      let depth = linePending + droppedParens;
      for (const word of words) depth += parenBalance(word).delta;
      if (patternHere && parenBalance(words[0] ?? "").delta < 0) depth++;
      const after = listed[index + 1]?.sep ??
        (trailing === "\n" ? "" : trailing);
      if (after === "\n" || after === "") {
        opensSubst = depth > 0;
        linePending = 0;
      } else {
        linePending = Math.max(0, depth);
      }
    }
    const pushSubst = () => {
      if (!opensSubst) return;
      push({ truth: true, sub: true, subst: true });
      const frame = stack.at(-1);
      if (frame) swallowedFrames.add(frame.id);
    };
    // A command that is only a keyword (`do`, `then`, `{`) can still end the
    // line with a `$(` open (`X=$(for d in a; do`), so open its frame too.
    if (words.length === 0) {
      prev = closeAfter ? pop()?.skippedStatus ?? null : closedStatus;
      pushSubst();
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
      const nextSep = listed[index + 1]?.sep ??
        (trailing === "\n" ? "" : trailing);
      out.push({
        words,
        sep,
        next: nextSep,
        // A group or subshell inside an `if`/`while` test is a condition
        // too: its status is the test's (PR #5332 review).
        condition: stack.some((frame) => frame.branch === "cond"),
        failureExits: failureExits(
          listed,
          index,
          stack.at(-1)?.sub && !stack.at(-1)?.subst ? linePending : null,
          hereWords,
        ),
        groupSwallowed: false,
        errexitIgnored: false,
        inLoop: stack.some((frame) => frame.iterates),
        subshellsInLoop: subshellsInsideLoops(stack),
        subshellsInCondition: subshellsInsideConditions(stack),
        inUntrackedParen,
        certain: runs === true && sep !== "|" &&
          nextSep !== "|" && nextSep !== "&" &&
          stack.every((frame) => frameCertain(frame, true)),
        subshells: stack.filter((frame) => frame.sub).map((frame) => frame.id),
      });
      enclosing.push(stack.map((frame) => frame.id));
      const at = commandIndex(words);
      const head = stripQuotes(words[at] ?? "");
      const certain = runs === true && sep !== "|" && sep !== "&" &&
        stack.every((frame) => frameCertain(frame));
      const stops = head === "exit" ||
        (head === "set" && readShellOptions(words.slice(at + 1)).noexec);
      // An `exit` or `set -n` inside a `$( … )` or backtick substitution ends
      // the substitution's subshell, not the body (PR #5332 review round 15).
      if (stops && certain && !inUntrackedParen) exited = true;
    }
    if (closeAfter) prev = pop()?.skippedStatus ?? prev;
    pushSubst();
  }
  // A subshell or substitution still open at the end: the walk lost track of
  // its `)`, so nothing inside it is credited (fails closed).
  for (const frame of stack) if (frame.sub) swallowedFrames.add(frame.id);
  for (const [k, cmd] of out.entries()) {
    cmd.groupSwallowed = strayClose ||
      (enclosing[k] ?? []).some((id) => swallowedFrames.has(id));
    cmd.errexitIgnored = (enclosing[k] ?? []).some((id) =>
      andLeftFrames.has(id)
    );
  }
  return out;
}
