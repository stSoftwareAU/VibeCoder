/**
 * Derives the cargo commands a repository's own pull-request workflows run, so
 * the worker can run the same checks locally before a push (Issue #4630).
 *
 * The checks are `cargo [+toolchain] clippy ...` (argv kept verbatim) and, where
 * no clippy run already compiles the test targets, `cargo [+toolchain] test
 * --no-run` built from a `cargo test`, `cargo nextest run` or `cargo llvm-cov`
 * line, keeping only its build-relevant flags.
 *
 * Only workflows that trigger on `pull_request` count. Within each job, every
 * step with a string `run:` is read by logical line (`logicalLines`), skipping
 * comment lines and lines that `isNonFailing` (so `|| true` lines do not count),
 * and steps marked `continue-on-error`. Each `&&` or `;` segment that is a cargo
 * command becomes a check. The working directory comes from the step, job or
 * workflow `working-directory`, or a preceding `cd <dir>` (in an earlier segment
 * or on an earlier line of the same step), and must be a plain relative path
 * inside the repository. The environment keeps only
 * cargo-relevant keys (`RUSTFLAGS` and similar). The toolchain comes from a
 * `dtolnay/rust-toolchain`, `actions-rust-lang/setup-rust-toolchain` or
 * `actions-rs/toolchain` step in the same job, unless the command names one.
 *
 * A command that cannot be reproduced faithfully (a GitHub expression, a pipe,
 * shell syntax such as `$`, a glob, a redirect or a grouping, an unterminated
 * quote, a working directory outside the repository) is reported in
 * `unverifiable` with the workflow name, so the caller fails loud rather than
 * passing silently. A workflow that cannot be parsed is reported the same way
 * when its text contains `cargo clippy`.
 *
 * Known limits:
 * - Only single and double quotes are read. `2>&1` is removed only at the end of
 *   a line. Command forms other than those above (for example `cargo hack`) are
 *   not recognised.
 * - A `cd` is honoured only as `cd <one plain word>` in its own `&&` or `;`
 *   segment, and holds for the rest of the step's run block, as in the shell.
 *   Any other `cd` form (and `pushd`, `popd`, a `cd` after `then`, `do`,
 *   `else` or `{`, or a `cd` on a line that `isNonFailing` skips) makes the following cargo commands in that step
 *   unverifiable.
 * - Unreadable tracked workflow files carry no text to inspect, so they are
 *   ignored by `repoCiCargoChecks`.
 *
 * Uses Australian English spelling (behaviour, normalise, recognise, etc.).
 */

import { parse as parseYaml } from "@std/yaml/parse";
import {
  isNonFailing,
  logicalLines,
  triggersOn,
} from "./ci_mutation_contract.ts";

/** Which cargo command a check is: clippy, or a compile of the test targets. */
export type CiCargoCheckKind = "clippy" | "test-build";

/** One cargo command that CI runs on pull requests. */
export interface CiCargoCheck {
  kind: CiCargoCheckKind;
  /** Repo-relative directory CI runs it in; "." for the root. */
  workingDirectory: string;
  /** Starts with "cargo"; optional "+toolchain" is argv[1]. */
  argv: string[];
  /** Cargo-relevant env CI sets (allow-list below). */
  env: Record<string, string>;
  /** Workflow file, for messages. */
  source: string;
}

/** The cargo commands found in a scan, and the ones that could not be reproduced. */
export interface CiCargoScan {
  checks: CiCargoCheck[];
  /** One human-readable reason per CI cargo command that cannot be reproduced faithfully; each names the workflow file. */
  unverifiable: string[];
}

type Mapping = Record<string, unknown>;

/** A shell word after quote removal. */
interface Word {
  text: string;
  /** Holds shell syntax this scanner does not reproduce (see `RISKY_UNQUOTED`). */
  risky: boolean;
}

/** Unquoted characters that expand, split, group, redirect, glob or pipe. */
const RISKY_UNQUOTED = /[`$|<>()*?{}~&\\]/;
/** Characters that still expand or escape inside double quotes. */
const RISKY_DOUBLE_QUOTED = /[`$\\]/;
/** A leading `NAME=` assignment word. Anchored, so it is linear. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Raw workflow text that names a cargo clippy command, for unparseable files. */
const CARGO_CLIPPY_TEXT = /\bcargo(?:\s+\+\S+)?\s+clippy\b/;
/** A toolchain name taken from a workflow, such as `stable` or `1.80.0`. */
const TOOLCHAIN_NAME = /^[\w.+-]+$/;
const SNIPPET_LENGTH = 200;
const CI_REDIRECT = "2>&1";
const WORKFLOWS_PREFIX = ".github/workflows/";

/** Env keys kept for the cargo commands; all others are ignored. */
const ENV_KEYS = new Set([
  "RUSTFLAGS",
  "RUSTDOCFLAGS",
  "RUSTUP_TOOLCHAIN",
  "CARGO_ENCODED_RUSTFLAGS",
  "CARGO_INCREMENTAL",
  "CARGO_NET_OFFLINE",
]);
const ENV_PREFIXES = ["CARGO_BUILD_", "CARGO_PROFILE_", "CARGO_TARGET_"];

/** Flags kept for a test-target compile that take no value. */
const TEST_BOOLEAN_FLAGS = new Set([
  "--workspace",
  "--all",
  "--all-features",
  "--no-default-features",
  "--locked",
  "--frozen",
  "--offline",
  "--release",
  "-r",
  "--lib",
  "--bins",
  "--tests",
  "--examples",
  "--benches",
  "--all-targets",
]);

/** Flags kept for a test-target compile that take a value. */
const TEST_VALUE_FLAGS = new Set([
  "-p",
  "--package",
  "--exclude",
  "--features",
  "-F",
  "--profile",
  "--target",
  "--manifest-path",
  "--test",
  "--bin",
  "--example",
  "--bench",
]);

function isMapping(value: unknown): value is Mapping {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `true` and `"true"` both mean the flag is set. */
function isTrueFlag(value: unknown): boolean {
  return value === true || value === "true";
}

/** A scalar as text, or `undefined` when absent. */
function scalarText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

/** Whether an env key is one of the cargo-relevant keys kept for a check. */
function keptEnvKey(key: string): boolean {
  if (key === "CARGO_TARGET_DIR" || key === "CARGO_BUILD_TARGET_DIR") {
    return false;
  }
  return ENV_KEYS.has(key) || ENV_PREFIXES.some((p) => key.startsWith(p));
}

/** The first 200 characters of a line, for messages. */
function snippet(line: string): string {
  return line.length > SNIPPET_LENGTH
    ? `${line.slice(0, SNIPPET_LENGTH)}...`
    : line;
}

/** The line without a trailing CI `2>&1` redirect, which is not shell syntax here. */
function stripCiRedirect(line: string): string {
  const trimmed = line.trimEnd();
  return trimmed.endsWith(CI_REDIRECT)
    ? trimmed.slice(0, -CI_REDIRECT.length)
    : line;
}

interface WordBuilder {
  text: string;
  risky: boolean;
  open: boolean;
}

/** Ends the word being built, if one was started (even an empty quoted one). */
function closeWord(builder: WordBuilder, words: Word[]): void {
  if (builder.open) words.push({ text: builder.text, risky: builder.risky });
  builder.text = "";
  builder.risky = false;
  builder.open = false;
}

interface LexedLine {
  /** The words of each `&&` or `;` separated command. */
  segments: Word[][];
  /** A quote is never closed, so the shell would not parse the line. */
  unterminated: boolean;
}

/**
 * Splits one logical line into commands on `&&` and `;`, and into words on
 * unquoted whitespace, reading single and double quotes. An unquoted `#` that
 * starts a word begins a comment. Linear in the line length.
 */
function lexLine(line: string): LexedLine {
  const segments: Word[][] = [];
  let words: Word[] = [];
  const builder: WordBuilder = { text: "", risky: false, open: false };
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote !== "") {
      if (ch === quote) quote = "";
      else {
        builder.text += ch;
        if (quote === '"' && RISKY_DOUBLE_QUOTED.test(ch)) builder.risky = true;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      builder.open = true;
    } else if (ch === " " || ch === "\t") {
      closeWord(builder, words);
    } else if (ch === "#" && !builder.open) {
      break;
    } else if (ch === ";" || (ch === "&" && line.charAt(i + 1) === "&")) {
      closeWord(builder, words);
      if (words.length > 0) segments.push(words);
      words = [];
      if (ch === "&") i++;
    } else {
      builder.open = true;
      builder.text += ch;
      if (RISKY_UNQUOTED.test(ch)) builder.risky = true;
    }
  }
  closeWord(builder, words);
  if (words.length > 0) segments.push(words);
  return { segments, unterminated: quote !== "" };
}

/** A cargo command read from one segment. */
interface CargoCommand {
  kind: CiCargoCheckKind;
  /** The explicit `+toolchain` word, without the plus. */
  toolchain?: string;
  /** Leading `NAME=value` words, which set env for this command only. */
  inline: Record<string, string>;
  /** The words after the subcommand (and after `run`, `test` or `nextest` where they belong to it). */
  args: Word[];
  /** A nextest run: its `--profile` names a nextest profile, not a cargo one. */
  nextest?: boolean;
}

/** The cargo command a segment runs, or `null` when it is not a clippy or test one. */
function cargoCommand(words: readonly Word[]): CargoCommand | null {
  const inline: Record<string, string> = {};
  let i = 0;
  for (; i < words.length && ASSIGNMENT.test(words[i]!.text); i++) {
    const text = words[i]!.text;
    const eq = text.indexOf("=");
    inline[text.slice(0, eq)] = text.slice(eq + 1);
  }
  if (words[i]?.text !== "cargo") return null;
  i++;
  let toolchain: string | undefined;
  const plus = words[i]?.text ?? "";
  if (plus.startsWith("+")) {
    toolchain = plus.slice(1);
    i++;
  }
  const sub = words[i]?.text;
  if (sub === "clippy") {
    return { kind: "clippy", toolchain, inline, args: words.slice(i + 1) };
  }
  if (sub === "test") {
    return { kind: "test-build", toolchain, inline, args: words.slice(i + 1) };
  }
  if (sub === "nextest" && words[i + 1]?.text === "run") {
    return {
      kind: "test-build",
      toolchain,
      inline,
      args: words.slice(i + 2),
      nextest: true,
    };
  }
  if (sub === "llvm-cov") {
    const next = words[i + 1]?.text;
    const skip = next === "nextest" || next === "test" ? 2 : 1;
    return {
      kind: "test-build",
      toolchain,
      inline,
      args: words.slice(i + skip),
      nextest: next === "nextest",
    };
  }
  return null;
}

/**
 * The build-relevant flags of a test run, in the order given, with values kept
 * as separate words. Everything after a lone `--` is dropped, and so is any
 * other word. Returns `null` for `--doc`, which is not a compile of the test
 * targets.
 *
 * For a nextest run (`nextest`), `--profile` selects a profile from
 * `.config/nextest.toml`, not a cargo build profile, so it and its value are
 * dropped (nextest's short `-P` is in neither flag set, so it is never kept);
 * nextest's own `--cargo-profile` is cargo's `--profile`. A cargo
 * build profile that `cargo llvm-cov nextest` takes under `--profile` is
 * therefore not reproduced: the compile uses the default profile, which can
 * never block a push for a profile that cargo does not define.
 */
function keptTestFlags(
  args: readonly Word[],
  nextest: boolean,
): string[] | null {
  const kept: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const text = args[i]!.text;
    if (text === "--") break;
    if (text === "--doc") return null;
    if (nextest) {
      if (text === "--profile") {
        i++;
        continue;
      }
      if (text.startsWith("--profile=")) continue;
      if (text === "--cargo-profile" && i + 1 < args.length) {
        kept.push("--profile", args[i + 1]!.text);
        i++;
        continue;
      }
      if (text.startsWith("--cargo-profile=")) {
        kept.push("--profile", text.slice("--cargo-profile=".length));
        continue;
      }
    }
    if (TEST_BOOLEAN_FLAGS.has(text)) {
      kept.push(text);
      continue;
    }
    const eq = text.indexOf("=");
    if (eq > 0 && TEST_VALUE_FLAGS.has(text.slice(0, eq))) {
      kept.push(text.slice(0, eq), text.slice(eq + 1));
      continue;
    }
    if (TEST_VALUE_FLAGS.has(text) && i + 1 < args.length) {
      kept.push(text, args[i + 1]!.text);
      i++;
    }
  }
  return kept;
}

/** The first reason a command line cannot be reproduced, or `null` when it can. */
function lineHazard(
  line: string,
  unterminated: boolean,
  words: readonly Word[],
): string | null {
  if (unterminated) return "it has an unterminated quote";
  if (line.includes("|")) return "it contains a pipe";
  if (line.includes("${{")) return "it holds a GitHub expression";
  if (words.some((word) => word.risky)) {
    return "it uses shell syntax the scanner does not reproduce";
  }
  return null;
}

/**
 * A working directory: a relative path inside the repository, normalised to
 * `x/y` with no `./` or trailing slash. Returns `null` for an absolute path, a
 * `~` or `$` expansion, or any `..` segment.
 */
function validDirectory(dir: string): string | null {
  if (dir.includes("$") || dir.startsWith("/") || dir.startsWith("~")) {
    return null;
  }
  const parts = dir.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.includes("..")) return null;
  return parts.length === 0 ? "." : parts.join("/");
}

/** The directory after `cd child` from `base`. Validation happens later. */
function joinDirectory(base: string, child: string): string {
  if (child.startsWith("/") || base === ".") return child;
  return `${base}/${child}`;
}

/** `defaults.run.working-directory` of a workflow or job, if set. */
function runDirectory(node: Mapping): string | undefined {
  const defaults = node.defaults;
  if (!isMapping(defaults) || !isMapping(defaults.run)) return undefined;
  return scalarText(defaults.run["working-directory"]);
}

/**
 * The env of one command: the sources merged in order (later wins), keeping
 * only the cargo-relevant keys. A kept value holding `$` names its key in
 * `expression`, since the value cannot be reproduced.
 */
function resolveEnv(sources: readonly Mapping[]): {
  env: Record<string, string>;
  expression?: string;
} {
  const merged = new Map<string, unknown>();
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (keptEnvKey(key)) merged.set(key, value);
    }
  }
  const env: Record<string, string> = {};
  for (const [key, value] of merged) {
    if (isMapping(value) || Array.isArray(value)) continue;
    const text = value === null ? "" : String(value);
    if (text.includes("$")) return { env, expression: key };
    env[key] = text;
  }
  return { env };
}

/** The toolchain a job's setup step names. */
type Toolchain =
  | { kind: "none" }
  | { kind: "set"; value: string }
  | { kind: "invalid"; value: string; hint: string };

/**
 * The toolchain a job's first toolchain-setup step names. `dtolnay/rust-toolchain@<ref>`
 * uses `with.toolchain` or the ref. The other two actions use `with.toolchain`
 * only. An absent or empty name means none. An expression, a name with unusual
 * characters, or a non-string `with.toolchain` (a YAML number such as an
 * unquoted `1.80`, which has already lost its text) is invalid.
 */
function jobToolchain(job: Mapping): Toolchain {
  const steps = job.steps;
  if (!Array.isArray(steps)) return { kind: "none" };
  for (const step of steps) {
    if (!isMapping(step) || typeof step.uses !== "string") continue;
    const at = step.uses.indexOf("@");
    const action = at === -1 ? step.uses : step.uses.slice(0, at);
    const ref = at === -1 ? undefined : step.uses.slice(at + 1);
    const dtolnay = action === "dtolnay/rust-toolchain";
    if (
      !dtolnay &&
      action !== "actions-rust-lang/setup-rust-toolchain" &&
      action !== "actions-rs/toolchain"
    ) continue;
    const withBlock = step.with;
    const rawWith = isMapping(withBlock) ? withBlock.toolchain : undefined;
    if (
      rawWith !== undefined && rawWith !== null && typeof rawWith !== "string"
    ) {
      return {
        kind: "invalid",
        value: String(rawWith),
        hint:
          "is a YAML number, not a string: quote it in the workflow so the version keeps its exact text",
      };
    }
    const withValue = typeof rawWith === "string" ? rawWith : undefined;
    const value = dtolnay ? withValue ?? ref : withValue;
    const name = (value ?? "").trim();
    if (name === "") return { kind: "none" };
    if (name.includes("$")) {
      return { kind: "invalid", value: name, hint: "holds an expression" };
    }
    if (!TOOLCHAIN_NAME.test(name)) {
      return { kind: "invalid", value: name, hint: "is not a plain name" };
    }
    return { kind: "set", value: name };
  }
  return { kind: "none" };
}

/** Per-job state shared by its steps. */
interface JobContext {
  fileName: string;
  /** Workflow `env` then job `env`. */
  envs: Mapping[];
  toolchain: Toolchain;
  checks: CiCargoCheck[];
  unverifiable: string[];
}

/** Shell keywords that may precede a command inside a compound command. */
const COMPOUND_KEYWORDS = new Set([
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "!",
  "{",
  "(",
]);

/** Whether a command word changes the shell's directory. */
function changesDirectory(word: string | undefined): boolean {
  return word === "cd" || word === "pushd" || word === "popd";
}

/** A segment's command words after any leading compound-command keywords. */
function afterKeywords(segment: Word[]): { lead: number; words: Word[] } {
  let lead = 0;
  while (COMPOUND_KEYWORDS.has(segment[lead]?.text ?? "")) lead++;
  return { lead, words: segment.slice(lead) };
}

/**
 * Reads one logical command line: its segments in order, tracking the working
 * directory through `cd`, and records each cargo command as a check or as an
 * unverifiable reason. Returns the directory the shell is in afterwards (`null`
 * when it is no longer known), which the next line of the same step starts in.
 */
function scanLine(
  ctx: JobContext,
  line: string,
  startDir: string | null,
  stepEnv: Mapping,
): string | null {
  const lexed = lexLine(stripCiRedirect(line));
  const shown = snippet(line);
  // `null` means the directory is no longer known after an unsupported `cd`.
  let dir: string | null = startDir;
  for (const segment of lexed.segments) {
    // A `cd` after `then`, `do` or `{` runs conditionally or in a group, so the
    // directory afterwards is not known.
    const { lead, words } = afterKeywords(segment);
    if (changesDirectory(words[0]?.text)) {
      const target = words[1];
      // Two words, so `target` is set.
      dir = lead === 0 && words[0]!.text === "cd" && dir !== null &&
          words.length === 2 && !target!.risky
        ? joinDirectory(dir, target!.text)
        : null;
      continue;
    }
    const command = cargoCommand(words);
    if (command === null) continue;
    const hazard = lineHazard(line, lexed.unterminated, words);
    if (hazard !== null) {
      ctx.unverifiable.push(
        `${ctx.fileName}: "${shown}" cannot be reproduced faithfully: ${hazard}`,
      );
      continue;
    }
    if (dir === null) {
      ctx.unverifiable.push(
        `${ctx.fileName}: "${shown}" follows a cd form that cannot be reproduced`,
      );
      continue;
    }
    const workingDirectory = validDirectory(dir);
    if (workingDirectory === null) {
      ctx.unverifiable.push(
        `${ctx.fileName}: working directory "${dir}" is not a relative path inside the repository ("${shown}")`,
      );
      continue;
    }
    const { env, expression } = resolveEnv([
      ...ctx.envs,
      stepEnv,
      command.inline,
    ]);
    if (expression !== undefined) {
      ctx.unverifiable.push(
        `${ctx.fileName}: ${expression} is an expression, so "${shown}" cannot be reproduced`,
      );
      continue;
    }
    let toolchain = command.toolchain;
    if (toolchain === undefined) {
      const job = ctx.toolchain;
      if (job.kind === "invalid") {
        ctx.unverifiable.push(
          `${ctx.fileName}: toolchain "${job.value}" ${job.hint}; "${shown}" cannot be reproduced`,
        );
        continue;
      }
      if (job.kind === "set") toolchain = job.value;
    }
    const prefix = toolchain === undefined
      ? ["cargo"]
      : ["cargo", `+${toolchain}`];
    let argv: string[];
    if (command.kind === "clippy") {
      argv = [...prefix, "clippy", ...command.args.map((w) => w.text)];
    } else {
      const flags = keptTestFlags(command.args, command.nextest === true);
      if (flags === null) continue;
      argv = [...prefix, "test", "--no-run", ...flags];
    }
    ctx.checks.push({
      kind: command.kind,
      workingDirectory,
      argv,
      env,
      source: ctx.fileName,
    });
  }
  return dir;
}

/**
 * The unverifiable reason for a workflow that cannot be parsed, when its raw
 * text still names a cargo clippy command. A file without that text is ignored.
 */
function unparsed(fileName: string, text: string): CiCargoScan {
  return {
    checks: [],
    unverifiable: CARGO_CLIPPY_TEXT.test(text)
      ? [
        `${fileName}: the workflow cannot be parsed, so its cargo clippy command cannot be checked`,
      ]
      : [],
  };
}

/** Selection flags that take no value, spelled as their canonical form. */
const SELECTION_BOOLEAN_FLAGS = new Map([
  ["--workspace", "--workspace"],
  ["--all", "--workspace"],
  ["--all-features", "--all-features"],
  ["--no-default-features", "--no-default-features"],
  ["--release", "--release"],
  ["-r", "--release"],
]);

/** Selection flags that take a value, spelled as their canonical form. */
const SELECTION_VALUE_FLAGS = new Map([
  ["-p", "--package"],
  ["--package", "--package"],
  ["--exclude", "--exclude"],
  ["--features", "--features"],
  ["-F", "--features"],
  ["--profile", "--profile"],
  ["--target", "--target"],
  ["--manifest-path", "--manifest-path"],
]);

/**
 * What a cargo check builds, as a sorted list of canonical terms: the toolchain,
 * the package, feature, profile and target selection, and the env. Words after a
 * lone `--` are ignored. Two checks with the same selection compile the same
 * crates, so one covers the other's test targets.
 */
function selectionOf(check: CiCargoCheck): string[] {
  const terms: string[] = [];
  const toolchain = check.argv[1];
  if (toolchain?.startsWith("+")) terms.push(`toolchain ${toolchain}`);
  for (const [key, value] of Object.entries(check.env)) {
    terms.push(`env ${key}=${value}`);
  }
  const words = check.argv.slice(2);
  const end = words.indexOf("--");
  const args = end === -1 ? words : words.slice(0, end);
  for (let i = 0; i < args.length; i++) {
    const word = args[i]!;
    const bool = SELECTION_BOOLEAN_FLAGS.get(word);
    if (bool !== undefined) {
      terms.push(bool);
      continue;
    }
    const eq = word.indexOf("=");
    const flag = eq > 0 ? word.slice(0, eq) : word;
    const canonical = SELECTION_VALUE_FLAGS.get(flag);
    if (canonical === undefined) continue;
    let value: string | undefined;
    if (eq > 0) value = word.slice(eq + 1);
    else if (i + 1 < args.length) value = args[++i];
    if (value === undefined) continue;
    if (canonical === "--features") {
      for (const feature of value.split(/[,\s]+/)) {
        if (feature !== "") terms.push(`--features ${feature}`);
      }
    } else terms.push(`${canonical} ${value}`);
  }
  return terms.sort();
}

/**
 * Merges checks that are the same command (kind, directory, argv and env), and
 * drops a test-target compile that a clippy check with `--all-targets` or
 * `--tests` already covers, because clippy compiles the test targets too. Clippy
 * covers a test build only in the same directory and with the same selection
 * (toolchain, packages, features, profile, target and env); otherwise the test
 * build is kept, so the checked set is never silently reduced.
 */
function finishChecks(checks: readonly CiCargoCheck[]): CiCargoCheck[] {
  const seen = new Map<string, CiCargoCheck>();
  for (const check of checks) {
    const key = JSON.stringify([
      check.kind,
      check.workingDirectory,
      check.argv,
      Object.entries(check.env).sort(),
    ]);
    if (!seen.has(key)) seen.set(key, check);
  }
  const unique = [...seen.values()];
  const covering = new Set(
    unique
      .filter((c) =>
        c.kind === "clippy" &&
        (c.argv.includes("--all-targets") || c.argv.includes("--tests"))
      )
      .map((c) => JSON.stringify([c.workingDirectory, selectionOf(c)])),
  );
  return unique.filter((c) =>
    !(c.kind === "test-build" &&
      covering.has(JSON.stringify([c.workingDirectory, selectionOf(c)])))
  );
}

/**
 * The cargo clippy and test-target compile commands one workflow file runs on
 * pull requests. A file that does not trigger on `pull_request` yields nothing.
 * A file that cannot be parsed yields an unverifiable reason when its text
 * names `cargo clippy`. Never throws on malformed workflow content.
 */
export function scanWorkflowForCargoChecks(
  fileName: string,
  text: string,
): CiCargoScan {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch {
    return unparsed(fileName, text);
  }
  if (!isMapping(doc)) return unparsed(fileName, text);
  if (!triggersOn(doc, "pull_request")) return { checks: [], unverifiable: [] };

  const checks: CiCargoCheck[] = [];
  const unverifiable: string[] = [];
  const workflowDir = runDirectory(doc);
  const workflowEnv = isMapping(doc.env) ? doc.env : {};
  const jobs = isMapping(doc.jobs) ? doc.jobs : {};
  for (const job of Object.values(jobs)) {
    if (!isMapping(job)) continue;
    const steps = job.steps;
    if (!Array.isArray(steps)) continue;
    const ctx: JobContext = {
      fileName,
      envs: [workflowEnv, isMapping(job.env) ? job.env : {}],
      toolchain: jobToolchain(job),
      checks,
      unverifiable,
    };
    const jobDir = runDirectory(job) ?? workflowDir ?? ".";
    for (const step of steps) {
      if (
        !isMapping(step) || typeof step.run !== "string" ||
        isTrueFlag(step["continue-on-error"])
      ) continue;
      const dir = scalarText(step["working-directory"]) ?? jobDir;
      const stepEnv = isMapping(step.env) ? step.env : {};
      // The shell keeps its directory from one line of a run block to the next.
      let current: string | null = dir;
      for (const line of logicalLines(step.run)) {
        if (line.trimStart().startsWith("#")) continue;
        if (isNonFailing(line)) {
          // Not scanned, but a `cd` here may or may not have taken effect.
          const lexed = lexLine(stripCiRedirect(line));
          if (
            lexed.segments.some((w) =>
              changesDirectory(afterKeywords(w).words[0]?.text)
            )
          ) {
            current = null;
          }
          continue;
        }
        current = scanLine(ctx, line, current, stepEnv);
      }
    }
  }
  return {
    checks: finishChecks(checks),
    unverifiable: [...new Set(unverifiable)],
  };
}

/**
 * The cargo clippy and test-target compile commands the repository's tracked
 * workflows run on pull requests. Only tracked `.github/workflows/*.yml|yaml`
 * paths are read. A workflow that cannot be read is ignored, since its text is
 * not available to inspect. Checks are merged and de-duplicated across files.
 */
export async function repoCiCargoChecks(
  repoRoot: string,
  tracked: readonly string[],
): Promise<CiCargoScan> {
  const checks: CiCargoCheck[] = [];
  const unverifiable: string[] = [];
  for (const path of tracked) {
    if (!path.startsWith(WORKFLOWS_PREFIX)) continue;
    if (!/\.ya?ml$/.test(path)) continue;
    let text: string;
    try {
      text = await Deno.readTextFile(`${repoRoot}/${path}`);
    } catch {
      continue;
    }
    const scan = scanWorkflowForCargoChecks(path, text);
    checks.push(...scan.checks);
    unverifiable.push(...scan.unverifiable);
  }
  return {
    checks: finishChecks(checks),
    unverifiable: [...new Set(unverifiable)],
  };
}
