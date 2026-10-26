/**
 * Keeping Rust build tools out of the best-practices idle-task scan
 * (Issue #4415).
 *
 * The best-practices scan is a **static** scan: it reads source and reports
 * findings. `cargo check` and `cargo clippy` are not static. They run build
 * scripts (`build.rs`), expand proc macros (including those of dependencies)
 * and write `target/`. A prompt that says "do not run cargo" is advice. This
 * module is the decision the scan's `PreToolUse` hook makes on each Bash call,
 * so the refusal does not depend on the agent reading the prompt.
 *
 * ## What this is, and is not
 *
 * This is hook-level command classification. It is not an OS sandbox: it reads
 * the command text the agent asked to run and denies the call when a command
 * word is a build tool. The scan also passes the same tools as
 * `Bash(<tool>:*)` rules in `disallowedTools`, as a second layer.
 *
 * The classifier sees literal command words only. Words the shell builds at run
 * time are not resolved: a variable holding a tool name (`X=cargo; $X check`),
 * `eval`, or a command substitution that expands to a tool name. The prompt's
 * static-only instruction still covers those.
 *
 * Only the best-practices scan's session installs this hook. Other sessions,
 * including the issue executor, are untouched.
 *
 * Uses Australian English throughout (behaviour, artefacts, organisation, etc.).
 */

import { resolveGuardDenoDir } from "./guard_deno_dir.ts";
import { resolveGuardModulePath } from "./guard_module_path.ts";
import type { IssueEditHookDecision } from "./issue_executor_enforcement.ts";
import { posixSingleQuote } from "./shell_quote.ts";

/** File name of the guard entry point the scan's hook command executes. */
export const STATIC_SCAN_GUARD_MODULE = "static_scan_guard_cli.ts";

/**
 * Marker opening every denial reason and log line this module emits.
 *
 * Stable by contract: the run log is grepped for it when a scan's refusals are
 * read, so it must not be re-styled.
 */
export const STATIC_SCAN_DENIAL_MARKER = "[static-scan-guard]";

/** The `PreToolUse` matcher the scan's hook is registered under. */
export const STATIC_SCAN_HOOK_MATCHER = "Bash";

/**
 * Build tools a static scan must not run.
 *
 * Any command word beginning `cargo-` (for example `cargo-clippy`) is treated
 * as a build tool as well; see {@link isBuildTool}.
 */
export const STATIC_SCAN_BUILD_TOOLS: readonly string[] = [
  "cargo",
  "rustc",
  "rustup",
  "rustdoc",
  "clippy-driver",
];

/**
 * The `disallowedTools` rules that refuse each build tool for the scan's
 * session. Derived from {@link STATIC_SCAN_BUILD_TOOLS}, so the list has one
 * source; `cargo-clippy` is added because it is the `cargo-` form a user is
 * most likely to type.
 */
export const STATIC_SCAN_DISALLOWED_BASH_TOOLS: readonly string[] = [
  ...STATIC_SCAN_BUILD_TOOLS.map((tool) => `Bash(${tool}:*)`),
  "Bash(cargo-clippy:*)",
];

/** Separators that end a command segment, outside single quotes. */
const SEPARATORS: ReadonlySet<string> = new Set([
  ";",
  "&",
  "|",
  "\n",
  "(",
  ")",
  "{",
  "}",
  "`",
]);

/** `NAME=value` (or `NAME+=value`): a leading environment assignment. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** A redirection at the start of a word, e.g. `>out`, `2>>log`, `<in`. */
const REDIRECTION = /^\d*(?:<<<?|<>|>>?|<&|>&|>\|)/;

/** A redirection operator standing alone, its target being the next word. */
const REDIRECTION_ONLY = /^\d*(?:<<<?|<>|>>?|<&|>&|>\|)$/;

/** Shell keywords that may precede a command in the same segment. */
const SKIPPED_KEYWORDS: ReadonlySet<string> = new Set([
  "!",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
]);

/**
 * Command wrappers that run their own argument as the command, and the
 * options each one takes an argument for (so the argument is not mistaken for
 * the command word).
 */
const WRAPPER_OPTIONS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["env", new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"])],
  ["command", new Set<string>()],
  ["exec", new Set(["-a"])],
  [
    "sudo",
    new Set([
      "-u",
      "-g",
      "-C",
      "-h",
      "-p",
      "-r",
      "-t",
      "-U",
      "--user",
      "--group",
    ]),
  ],
  ["nice", new Set(["-n", "--adjustment"])],
  ["nohup", new Set<string>()],
  ["time", new Set(["-f", "-o", "--format", "--output"])],
  ["timeout", new Set(["-s", "-k", "--signal", "--kill-after"])],
  [
    "xargs",
    new Set([
      "-I",
      "-n",
      "-P",
      "-d",
      "-L",
      "-E",
      "-s",
      "-a",
      "--max-args",
      "--max-procs",
      "--delimiter",
    ]),
  ],
]);

/** Shells whose `-c` argument is a command string this module re-reads. */
const SHELLS: ReadonlySet<string> = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
]);

/** The fields of a `PreToolUse` hook payload this guard reads. */
export interface StaticScanHookPayload {
  /** The event — only `PreToolUse` carries a permission decision. */
  hook_event_name?: unknown;
  /** The tool about to run, e.g. `Bash`. */
  tool_name?: unknown;
  /** The tool's arguments; only `command` is read. */
  tool_input?: { command?: unknown };
}

/** A non-empty string, or undefined for anything else. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Split a command into segments of words, with quotes removed from the words.
 *
 * Separators end a segment everywhere outside single quotes, including inside
 * double quotes and `$(…)`, so a payload that hides a build tool behind a
 * separator is still reached. Over-matching is accepted: a double-quoted
 * `"a; cargo"` is split too, and is denied. Single-quoted text is literal, so
 * `echo 'cargo check'` yields one ordinary word.
 *
 * @param command - The Bash command text
 * @returns The segments, each a list of word values, empty segments dropped
 */
function splitSegments(command: string): string[][] {
  const segments: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  let quote: "'" | '"' | undefined;
  // Set once a separator has fired inside the current double-quoted span: the
  // text after it is read as a command, so its whitespace ends words.
  let splitInsideDoubleQuotes = false;

  const flushWord = (): void => {
    if (word !== undefined) {
      words.push(word);
      word = undefined;
    }
  };
  const flushSegment = (): void => {
    flushWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  const append = (value: string): void => {
    word = (word ?? "") + value;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (quote === "'") {
      if (ch === "'") quote = undefined;
      else append(ch);
      continue;
    }

    if (quote === '"') {
      if (ch === '"') {
        quote = undefined;
        splitInsideDoubleQuotes = false;
        continue;
      }
      if (ch === "\\" && i + 1 < command.length) {
        const next = command[i + 1]!;
        if ('"\\$`'.includes(next)) {
          append(next);
          i++;
          continue;
        }
      }
      if (SEPARATORS.has(ch)) {
        flushSegment();
        splitInsideDoubleQuotes = true;
        continue;
      }
      if (splitInsideDoubleQuotes && (ch === " " || ch === "\t")) {
        flushWord();
        continue;
      }
      append(ch);
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      append("");
      continue;
    }
    if (ch === "\\") {
      if (i + 1 < command.length) append(command[++i]!);
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      flushWord();
      continue;
    }
    if (SEPARATORS.has(ch)) {
      flushSegment();
      continue;
    }
    append(ch);
  }

  flushSegment();
  return segments;
}

/** The final path component of a word, so `/usr/bin/cargo` reads as `cargo`. */
function baseName(word: string): string {
  return word.slice(word.lastIndexOf("/") + 1);
}

/** Whether a command word names a build tool this scan must not run. */
function isBuildTool(base: string): boolean {
  return STATIC_SCAN_BUILD_TOOLS.includes(base) || base.startsWith("cargo-");
}

/**
 * Index just past a wrapper's own options and operands, so the next word is
 * the command the wrapper runs.
 *
 * `timeout` takes one duration operand after its options.
 *
 * @param words - The segment's words
 * @param start - Index of the first word after the wrapper
 * @param wrapper - The wrapper's base name
 * @param options - The options that take an argument
 * @returns The index of the wrapped command word
 */
function skipWrapperArgs(
  words: readonly string[],
  start: number,
  wrapper: string,
  options: ReadonlySet<string>,
): number {
  let i = start;
  let durationPending = wrapper === "timeout";
  while (i < words.length) {
    const word = words[i]!;
    if (ASSIGNMENT.test(word)) {
      i++;
      continue;
    }
    if (word.startsWith("-") && word !== "-") {
      i += options.has(word) ? 2 : 1;
      continue;
    }
    if (durationPending) {
      durationPending = false;
      i++;
      continue;
    }
    break;
  }
  return i;
}

/**
 * Index just past `rustup run <toolchain>`'s options and toolchain, so the
 * next word is the command run under that toolchain.
 *
 * @param words - The segment's words
 * @param start - Index of the first word after `run`
 * @returns The index of the command word
 */
function skipRustupRun(words: readonly string[], start: number): number {
  let i = start;
  while (i < words.length && words[i]!.startsWith("-")) i++;
  return i + 1;
}

/**
 * The command string a shell's `-c` option names, if it has one.
 *
 * A short option cluster containing `c` (`-c`, `-lc`) counts. Other options
 * are skipped, so `bash -o pipefail -c '…'` is read the same way.
 *
 * @param words - The segment's words
 * @param start - Index of the first word after the shell
 * @returns The `-c` string, or `undefined` when the shell runs no string
 */
function shellPayload(
  words: readonly string[],
  start: number,
): string | undefined {
  for (let i = start; i < words.length; i++) {
    const word = words[i]!;
    const isCommandFlag = word.length > 1 && word.startsWith("-") &&
      !word.startsWith("--") && /^[A-Za-z]+$/.test(word.slice(1)) &&
      word.includes("c", 1);
    if (isCommandFlag) return words[i + 1];
  }
  return undefined;
}

/**
 * The build tool a single segment invokes in command position, if any.
 *
 * Leading assignments, keywords, redirections and wrappers are skipped, so the
 * word that is actually run is the one checked.
 *
 * @param words - The segment's words
 * @returns The build tool's name, or `undefined`
 */
function invocationInSegment(words: readonly string[]): string | undefined {
  let i = 0;
  while (i < words.length) {
    const word = words[i]!;
    if (ASSIGNMENT.test(word) || SKIPPED_KEYWORDS.has(word)) {
      i++;
      continue;
    }
    if (REDIRECTION.test(word)) {
      i += REDIRECTION_ONLY.test(word) ? 2 : 1;
      continue;
    }

    const base = baseName(word);
    if (base === "rustup" && words[i + 1] === "run") {
      i = skipRustupRun(words, i + 2);
      continue;
    }
    const options = WRAPPER_OPTIONS.get(base);
    if (options !== undefined) {
      i = skipWrapperArgs(words, i + 1, base, options);
      continue;
    }

    if (isBuildTool(base)) return base;
    if (SHELLS.has(base)) {
      const payload = shellPayload(words, i + 1);
      return payload === undefined
        ? undefined
        : findStaticScanBuildInvocation(payload);
    }
    return undefined;
  }
  return undefined;
}

/**
 * The build tool a Bash command invokes in command position, if any.
 *
 * Checks each segment's command word. Only command position counts: `cargo`
 * appearing as an argument (`grep -n cargo Cargo.toml`, `gh issue create
 * --title "cargo clippy finding"`) is not an invocation. For `sh|bash|zsh -c
 * '<string>'` the string is read as a command in turn. Recursion always runs on
 * a strictly shorter string, so it terminates.
 *
 * @param command - The Bash command text from the hook payload
 * @returns The build tool's name (for example `cargo`, `cargo-clippy`), or `undefined`
 */
export function findStaticScanBuildInvocation(
  command: string,
): string | undefined {
  for (const words of splitSegments(command)) {
    const tool = invocationInSegment(words);
    if (tool !== undefined) return tool;
  }
  return undefined;
}

/**
 * The denial a build-tool invocation receives.
 *
 * States the cause plainly, so the agent reports compiler corroboration as not
 * checked rather than retrying the build tool under another name.
 *
 * @param tool - The build tool that was refused
 * @returns The denial reason, opening with {@link STATIC_SCAN_DENIAL_MARKER}
 */
function buildToolReason(tool: string): string {
  return `${STATIC_SCAN_DENIAL_MARKER} ${tool} denied: the best-practices ` +
    `scan is static. Build tools run build scripts (build.rs) and proc ` +
    `macros, including those of dependencies, and write build artefacts ` +
    `(target/), so a static scan does not run them. Report compiler ` +
    `corroboration as not checked instead (Issue #4415).`;
}

/**
 * Decide whether one `PreToolUse` call from the scan must be denied.
 *
 * Deny when the tool is `Bash` and its command invokes a build tool. Also deny
 * (fail closed) when the payload is not an object, and when the tool is `Bash`
 * but the command is missing or not a string, because the call then cannot be
 * classified. Everything else is allowed: other tools, and other events.
 *
 * @param payload - The hook payload, as parsed from the guard's stdin
 * @returns The decision, carrying the tool name and reason when denying
 */
export function decideStaticScanHook(payload: unknown): IssueEditHookDecision {
  if (
    typeof payload !== "object" || payload === null || Array.isArray(payload)
  ) {
    return {
      deny: true,
      tool: "payload",
      reason: `${STATIC_SCAN_DENIAL_MARKER} the hook payload is not an ` +
        `object, so the call cannot be classified and the scan fails closed ` +
        `(Issue #4415).`,
    };
  }
  const input = payload as StaticScanHookPayload;

  const event = text(input.hook_event_name);
  if (event !== undefined && event !== "PreToolUse") return { deny: false };

  if (text(input.tool_name) !== "Bash") return { deny: false };

  const command = input.tool_input?.command;
  if (typeof command !== "string") {
    return {
      deny: true,
      tool: "Bash",
      reason: `${STATIC_SCAN_DENIAL_MARKER} Bash denied: the call carried no ` +
        `command string, so it cannot be classified and the scan fails ` +
        `closed (Issue #4415).`,
    };
  }

  let tool: string | undefined;
  try {
    tool = findStaticScanBuildInvocation(command);
  } catch {
    // Nesting deep enough to exhaust the stack cannot be classified.
    return {
      deny: true,
      tool: "Bash",
      reason: `${STATIC_SCAN_DENIAL_MARKER} Bash denied: the command could ` +
        `not be classified and the scan fails closed (Issue #4415).`,
    };
  }
  if (tool === undefined) return { deny: false };
  return { deny: true, tool, reason: buildToolReason(tool) };
}

/**
 * Build the `--settings` payload that installs the scan's guard.
 *
 * One `PreToolUse` command hook under the `Bash` matcher. Passed as a JSON
 * string, which `--settings` accepts beside a path.
 *
 * @param opts.denoPath - Absolute path of the `deno` binary running the guard
 * @param opts.guardModulePath - Absolute path of the guard entry point
 * @param opts.denoDir - Read-only Deno cache to pin the guard child to, so the
 *   agent's environment cannot point it at a cache it prepared (Issue #1448).
 *   Omitted inherits the environment.
 * @returns The settings object the CLI merges for this invocation
 */
export function buildStaticScanHookSettings(opts: {
  denoPath: string;
  guardModulePath: string;
  denoDir?: string;
}): Record<string, unknown> {
  const pinnedCache = opts.denoDir
    ? `DENO_DIR=${posixSingleQuote(opts.denoDir)} `
    : "";
  const command = `${pinnedCache}${posixSingleQuote(opts.denoPath)} run ` +
    `--quiet --no-config --no-lock ${posixSingleQuote(opts.guardModulePath)}`;
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: STATIC_SCAN_HOOK_MATCHER,
          hooks: [{ type: "command", command }],
        },
      ],
    },
  };
}

/**
 * The settings the production best-practices scan installs its guard with.
 *
 * Resolves the running `deno` binary and the guard module through
 * {@link resolveGuardModulePath}, so the guard executed is the read-only
 * checkout's copy (Issue #1444). Both are injectable so a test asserts the
 * shape without depending on where it runs.
 *
 * @param opts.denoPath - Override the resolved `deno` binary
 * @param opts.guardModulePath - Override the resolved guard entry point
 * @returns The settings object, ready to be JSON-stringified into `--settings`
 */
export function resolveStaticScanHookSettings(
  opts: { denoPath?: string; guardModulePath?: string } = {},
): Record<string, unknown> {
  // `""` asks for no per-run fallback: where no read-only seed exists the guard
  // child inherits the environment's cache, as every other Deno child does.
  const cache = resolveGuardDenoDir("");
  return buildStaticScanHookSettings({
    denoPath: opts.denoPath ?? Deno.execPath(),
    guardModulePath: opts.guardModulePath ??
      resolveGuardModulePath(STATIC_SCAN_GUARD_MODULE, import.meta.url),
    ...(cache.readOnly ? { denoDir: cache.path } : {}),
  });
}
