/**
 * Cargo-deny CI gate (Issue #4626).
 *
 * CI runs `cargo deny check` on fleet PRs, but the Mac-side push gates never
 * ran it, so a dependency-audit failure only surfaced after the push. This
 * module reads the repository's own workflows, finds the cargo-deny
 * invocations CI makes, and hands the pre-push gate the same argv to run
 * locally.
 *
 * Fail closed. A CI invocation that cannot be reproduced locally blocks the
 * push. A failure that shows the tool itself is unavailable (no network, no
 * advisory database, no cargo-deny binary) is an infrastructure deferral,
 * never a pass and never a verdict. Any other non-zero exit is a verdict, unless CI allows the
 * invocation to fail (see below), when it is a warning.
 *
 * The gate never adds `--offline`, an ignore list or a reduced-scope flag.
 * A `${{ matrix.<key> }}` expression is expanded from the job's literal
 * matrix, one invocation per combination. An expression or variable that
 * cannot be expanded is dropped, together with the option it was the value of,
 * so the invocation runs a plain `check` (every check, so every subset) with
 * the action's defaults. Only a `cargo deny` line that names no `check` and
 * holds one, or a working directory that cannot be resolved, stays unrunnable.
 *
 * An invocation CI allows to fail (`continue-on-error` on its step or job: a
 * literal true, or a `matrix.<key>` test evaluated for each combination) still
 * runs, but a failure is a warning, never a verdict.
 *
 * A workflow CI does not run for the push (a `schedule`-only audit, or a
 * `paths` filter that selects none of the branch's touched paths) is not read:
 * the gate is no stricter than CI.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
// Reviewer entry points also load this module outside the worker's import map.
// deno-lint-ignore no-import-prefix
import { parse as parseYaml } from "jsr:@std/yaml@^1.0.12/parse";
import {
  type PreFlightGateError,
  type PreFlightRunner,
  runPreFlightGate,
  tokeniseCommand,
} from "./pre_flight_gate.ts";

/** One cargo-deny invocation CI makes, or a CI invocation we cannot reproduce. */
export type CargoDenyCiFinding =
  | {
    kind: "command";
    argv: string[];
    cwd: string;
    /** CI allows this invocation to fail (`continue-on-error`); set only when true. */
    allowFailure?: true;
  }
  | { kind: "unrunnable"; source: string; reason: string };

/** A cargo-deny gate failure: a real verdict, or the tool could not run. */
export type CargoDenyGateError = {
  kind: "verdict" | "infrastructure";
  message: string;
};

/** The most characters of a failed check's output kept in a warning. */
const WARNING_CAP = 1000;

/** Longest line the parser's messages and the classifier will examine. */
const LINE_CAP = 2000;

const INFRA_PREFIX =
  "cargo deny could not run, so the dependency audit was not checked (this is not a pass): ";

/** A YAML list item, `- ` at the start of a line (a workflow step). */
const LIST_ITEM = /^(\s*)-(.*)$/;
const MAPPING_KEY = /^([A-Za-z_][\w-]*):(.*)$/;
const BLOCK_INDICATOR = /^[|>][-+0-9]*$/;
const CARGO_DENY_START = /^cargo\s+deny\b/;
const ACTION_REPO = /^embarkstudios\/cargo-deny-action(?:@|$)/i;
const TRIGGER_BASENAMES = new Set([
  "Cargo.toml",
  "Cargo.lock",
  "deny.toml",
  ".deny.toml",
]);
const TRIGGER_CARGO_CONFIG = /(?:^|\/)\.cargo\/(?:config|deny)\.toml$/;

/** A diagnostic from cargo-deny itself: a verdict on the dependency graph. */
const VERDICT_LINE = /^error\[[a-z0-9-]+\]/;
/** Optional `2026-11-07 18:04:31 [ERROR] ` style prefix on a log line. */
const LOG_PREFIX = /^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} )?(?:\[[A-Z]+\] )?/;
const URL_CREDENTIALS = /\/\/[^\s/@]+@/g;

/**
 * Lines that show the tool could not reach its inputs. Each is matched
 * anchored at the start of a line (after the log prefix), never as a
 * substring of the output.
 */
const TOOL_UNAVAILABLE: readonly RegExp[] = [
  /^failed to fetch advisory database/,
  /^fatal: unable to access/,
  /^error: no such command: `deny`/,
  /^(?:(?:warning|error): )?spurious network error/,
  /^failed to download/,
  /^download of config\.json failed/,
  /^Could not resolve host/,
  /^Couldn't resolve host/,
  /^Network is unreachable/,
  /^Connection (?:refused|timed out|reset)/,
];

/** The action's input defaults (EmbarkStudios/cargo-deny-action action.yml). */
const ACTION_DEFAULTS = {
  "log-level": "warn",
  "manifest-path": "./Cargo.toml",
  arguments: "--all-features",
  command: "check",
  "command-arguments": "",
} as const;
type ActionInput = keyof typeof ACTION_DEFAULTS;

interface YamlLine {
  indent: number;
  text: string;
  no: number;
}

interface MappingLine {
  key: string;
  raw: string;
  no: number;
  children: YamlLine[];
}

type WorkDir = { ok: true; cwd: string } | { ok: false; reason: string };

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isSkippable(text: string): boolean {
  const t = text.trim();
  return t === "" || t.startsWith("#");
}

/** Split `key: value` (the key must be a plain identifier). */
function parseMapping(text: string): { key: string; raw: string } | null {
  const m = MAPPING_KEY.exec(text.trim());
  if (!m) return null;
  const after = m[2] ?? "";
  if (after !== "" && !/^\s/.test(after)) return null;
  return { key: m[1] ?? "", raw: after.trim() };
}

/**
 * A YAML scalar's value: a plain value loses its ` #` comment, and a quoted
 * value loses its quotes, so `run: "cargo deny check"` is still seen.
 */
function scalarValue(raw: string): string {
  let v = raw.trim();
  if (v.startsWith("#")) return "";
  if (!/^["']/.test(v)) {
    const comment = v.search(/\s#/);
    if (comment !== -1) v = v.slice(0, comment).trimEnd();
  }
  const quote = v.charAt(0);
  if (
    v.length >= 2 && (quote === '"' || quote === "'") && v.endsWith(quote)
  ) {
    return v.slice(1, -1);
  }
  return v;
}

function splitWords(value: string): string[] {
  return value.split(/\s+/).filter((word) => word !== "");
}

/**
 * Cut a shell command at its first unquoted operator (`&&`, `||`, `;`, `|`,
 * `&`, a redirect) or comment. The digit of a `2>&1` file descriptor goes
 * with the redirect, so it does not become an argument.
 */
function cutAtShellOperator(command: string): string {
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command.charAt(i);
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    const startsWord = i === 0 || /\s/.test(command.charAt(i - 1));
    if (ch === "#" && startsWord) return command.slice(0, i);
    if ("&|;<>".includes(ch)) {
      const fdDigit = (ch === ">" || ch === "<") &&
        /\d/.test(command.charAt(i - 1)) &&
        (i === 1 || /\s/.test(command.charAt(i - 2)));
      return command.slice(0, fdDigit ? i - 1 : i);
    }
  }
  return command;
}

/**
 * Join backslash-continued lines into one logical command each. A line
 * ending in `\` continues onto the next line.
 */
function joinContinuations(
  lines: readonly YamlLine[],
): { text: string; no: number }[] {
  const commands: { text: string; no: number }[] = [];
  let pending: { text: string; no: number } | null = null;
  for (const line of lines) {
    const piece = line.text.trim();
    pending = pending === null
      ? { text: piece, no: line.no }
      : { text: `${pending.text} ${piece}`, no: pending.no };
    if (pending.text.endsWith("\\")) {
      pending = { text: pending.text.slice(0, -1).trimEnd(), no: pending.no };
      continue;
    }
    commands.push(pending);
    pending = null;
  }
  if (pending !== null) commands.push(pending);
  return commands;
}

/** What a step inherits from its job and workflow. */
interface JobContext {
  matrix: Record<string, unknown>;
  /** `defaults.run.working-directory` of the job, else of the workflow. */
  defaultWd: string | undefined;
  /** The job's `continue-on-error`, as written. */
  continueOnError: string | undefined;
}

/** The step-level view of one step, with the job's context folded in. */
interface StepContext {
  matrix: Record<string, unknown>;
  /** The `working-directory` a `run:` command executes in, as written. */
  wd: string | undefined;
  /** Every `continue-on-error` value that applies (the step's, then the job's). */
  continueOnError: readonly string[];
}

/** The working directory a step's run commands execute in. */
function resolveWorkingDirectory(wd: string | undefined): WorkDir {
  if (wd === undefined || wd === "") return { ok: true, cwd: "." };
  if (wd.startsWith("/") || wd.includes("..") || /[${]/.test(wd)) {
    return {
      ok: false,
      reason: `working-directory "${wd}" is not a plain relative path ` +
        `(it uses "..", a shell variable, a workflow expression or an ` +
        `absolute path), so the directory cannot be reproduced locally`,
    };
  }
  return { ok: true, cwd: wd };
}

/** `NAME=` at the start of a shell command: an environment assignment. */
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;

/**
 * Split a shell line into its command segments at unquoted `;`, `|`, `&`,
 * `&&` and `||`, and stop at a shell comment. A `&` that is part of a
 * redirect (`2>&1`, `&>`) is not a separator.
 */
function splitShellSegments(line: string): string[] {
  const segments: string[] = [];
  let quote = "";
  let start = 0;
  let end = line.length;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    const startsWord = i === 0 || /\s/.test(line.charAt(i - 1));
    if (ch === "#" && startsWord) {
      end = i;
      break;
    }
    if (ch !== ";" && ch !== "|" && ch !== "&") continue;
    const inRedirect = ch === "&" &&
      (line.charAt(i - 1) === ">" || line.charAt(i - 1) === "<" ||
        line.charAt(i + 1) === ">");
    if (inRedirect) continue;
    segments.push(line.slice(start, i));
    start = i + 1;
  }
  segments.push(line.slice(start, end));
  return segments;
}

/**
 * The command text after any leading `NAME=value` environment assignments.
 * A quoted value may contain spaces or operators.
 */
function stripEnvAssignments(segment: string): string {
  let rest = segment.trimStart();
  while (ENV_ASSIGNMENT.test(rest)) {
    let quote = "";
    let i = rest.indexOf("=") + 1;
    for (; i < rest.length; i++) {
      const ch = rest.charAt(i);
      if (quote !== "") {
        if (ch === quote) quote = "";
        continue;
      }
      // A `${{ ... }}` expression may hold spaces; it is one value.
      if (rest.startsWith("${{", i)) {
        const close = rest.indexOf("}}", i);
        if (close === -1) break;
        i = close + 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (/\s/.test(ch)) break;
    }
    rest = rest.slice(i).trimStart();
  }
  return rest;
}

/** A workflow expression or shell variable left in a token. */
const UNRESOLVED = /[$`]/;
/** A `${{ ... }}` expression, whose spaces would split it across tokens. */
const WORKFLOW_EXPRESSION = /\$\{\{[^}]{0,500}\}\}/g;
/** A `${{ matrix.<key> }}` expression. */
const MATRIX_EXPRESSION = /\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g;
/** A matrix value that is safe to place in an argv: no quoting or shell syntax. */
const SAFE_MATRIX_VALUE = /^[\w./ ,=:@+-]*$/;
/** The most matrix combinations the gate expands before it falls back. */
const MAX_MATRIX_COMBINATIONS = 64;

function matrixScalar(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean"
    ? String(value)
    : undefined;
}

/** The distinct matrix keys the texts name in `${{ matrix.<key> }}`. */
function matrixKeys(texts: readonly string[]): string[] {
  return [
    ...new Set(
      texts.flatMap((text) =>
        [...text.matchAll(MATRIX_EXPRESSION)].map((match) => match[1] ?? "")
      ),
    ),
  ];
}

/** Any `matrix.<key>` a `continue-on-error` test reads, in whatever form. */
const CONTINUE_MATRIX_KEY = /\bmatrix\.([\w-]+)/g;

/** The distinct matrix keys a `continue-on-error` test reads. */
function continueKeys(texts: readonly string[]): string[] {
  return [
    ...new Set(
      texts.flatMap((text) =>
        [...text.matchAll(CONTINUE_MATRIX_KEY)].map((match) => match[1] ?? "")
      ),
    ),
  ];
}

/**
 * The value of each of `keys` in every combination of the job's literal
 * `strategy.matrix`: the lists cross, each `include` entry adds to the
 * combinations it matches or is its own combination, and `exclude` is not
 * applied (an excluded combination is checked too, which is stricter). Null
 * when a key has no literal value in some combination, a value is not a plain
 * scalar, or there are too many combinations: the caller then falls back to a
 * plain `check`. A key in `optionalKeys` may be missing from a combination
 * (it is then "", as in a workflow expression) and need not be a safe value.
 * Every dimension a key or an `include` entry names is expanded before the
 * entries are applied; the combinations are then projected onto the keys.
 */
function matrixCombinations(
  matrix: Record<string, unknown>,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, string>[] | null {
  const wanted = [
    ...keys,
    ...optionalKeys.filter((key) => !keys.includes(key)),
  ];
  if (wanted.length === 0) return [{}];
  const dimensions = Object.entries(matrix).filter(([key, value]) =>
    key !== "include" && key !== "exclude" && Array.isArray(value)
  );
  const includes = Array.isArray(matrix.include) ? matrix.include : [];
  // A dimension an `include` entry names is expanded too, so the entry is
  // added only to the combinations it matches, not to a collapsed one.
  const includeKeys = new Set(
    includes.flatMap((entry) =>
      entry === null || typeof entry !== "object" ? [] : Object.keys(entry)
    ),
  );
  let combinations: Record<string, string>[] = dimensions.length === 0
    ? []
    : [{}];
  for (const [key, list] of dimensions) {
    if (!wanted.includes(key) && !includeKeys.has(key)) continue;
    const values = (list as unknown[]).map(matrixScalar);
    if (values.length === 0 || values.some((value) => value === undefined)) {
      return null;
    }
    combinations = combinations.flatMap((combination) =>
      values.map((value) => ({ ...combination, [key]: value as string }))
    );
    if (combinations.length > MAX_MATRIX_COMBINATIONS) return null;
  }
  for (const entry of includes) {
    if (entry === null || typeof entry !== "object") continue;
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry)) {
      const scalar = matrixScalar(value);
      if (scalar !== undefined) values[key] = scalar;
    }
    let matched = false;
    combinations = combinations.map((combination) => {
      const agrees = Object.entries(combination).every(([key, value]) =>
        values[key] === undefined || values[key] === value
      );
      if (!agrees) return combination;
      matched = true;
      return { ...values, ...combination };
    });
    // An entry naming no wanted key adds nothing a wanted key could read.
    if (!matched) combinations.push(values);
  }
  if (combinations.length > MAX_MATRIX_COMBINATIONS) return null;
  const seen = new Set<string>();
  const result: Record<string, string>[] = [];
  for (const combination of combinations) {
    const picked: Record<string, string> = {};
    for (const key of wanted) {
      const value = combination[key];
      if (keys.includes(key)) {
        if (value === undefined || !SAFE_MATRIX_VALUE.test(value)) return null;
      }
      picked[key] = value ?? "";
    }
    const id = JSON.stringify(picked);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(picked);
  }
  return result.length === 0 ? null : result;
}

/** `text` with each `${{ matrix.<key> }}` replaced by the combination's value. */
function substituteMatrix(
  text: string,
  combination: Readonly<Record<string, string>>,
): string {
  return text.replace(
    MATRIX_EXPRESSION,
    (_match, key: string) => combination[key] ?? "",
  );
}

/** A `continue-on-error` value that is a literal true. */
const CONTINUE_LITERAL = /^(?:true|\$\{\{\s*true\s*\}\})$/i;
/**
 * A `continue-on-error` test on one matrix key: `${{ matrix.<key> }}`, or
 * `${{ matrix.<key> == '<value>' }}` (also `!=`, and an unquoted value).
 */
const CONTINUE_MATRIX_TEST =
  /^\$\{\{\s*matrix\.([\w-]+)(?:\s*(==|!=)\s*(?:'([^']{0,200})'|([\w.-]{1,200})))?\s*\}\}$/;

/**
 * Whether a `continue-on-error` value lets the invocation of `combination`
 * fail. A literal true does. A matrix test is evaluated for the combination as
 * GitHub does (strings compare without regard to case, a missing key is "").
 * Anything else, and any test with no combination to evaluate it on, does
 * not: the failure then blocks.
 */
function continueOnErrorAllows(
  value: string,
  combination: Readonly<Record<string, string>> | null,
): boolean {
  const text = value.trim();
  if (CONTINUE_LITERAL.test(text)) return true;
  if (combination === null) return false;
  const test = CONTINUE_MATRIX_TEST.exec(text);
  if (test === null) return false;
  const actual = (combination[test[1] ?? ""] ?? "").toLowerCase();
  if (test[2] === undefined) return actual === "true";
  const expected = (test[3] ?? test[4] ?? "").toLowerCase();
  return (actual === expected) === (test[2] === "==");
}

/** `allowFailure: true` when any of the step's `continue-on-error` values allows it. */
function allowFailureFor(
  ctx: StepContext,
  combination: Readonly<Record<string, string>> | null,
): { allowFailure?: true } {
  return ctx.continueOnError.some((value) =>
      continueOnErrorAllows(value, combination)
    )
    ? { allowFailure: true }
    : {};
}

/**
 * The tokens with each variable or expression that is left dropped. An option
 * the dropped token stood after is dropped with it, so no option is left
 * without its value (`--config ${{ env.X }}` goes whole). The command is then
 * a plain check of what remains.
 */
function dropUnresolved(tokens: readonly string[]): string[] {
  const kept: string[] = [];
  for (const token of tokens) {
    if (!UNRESOLVED.test(token)) {
      kept.push(token);
      continue;
    }
    // `kept` always holds `cargo`, so there is a previous token; "" is for the types.
    const previous = kept.at(-1) ?? "";
    if (previous.startsWith("-") && !previous.includes("=")) kept.pop();
  }
  return kept;
}

/**
 * The findings for one command segment of a shell line. A `${{ matrix.<key> }}`
 * expression is expanded from the job's literal matrix, one invocation per
 * combination. A variable or expression that stays, before or after `check`,
 * is dropped, so the invocation runs a plain `check`, which covers every subset
 * the variable could select. One in a command that names no `check` could
 * stand for another subcommand, so that is unrunnable.
 */
function segmentFindings(
  segment: string,
  no: number,
  ctx: StepContext,
): CargoDenyCiFinding[] {
  // The text before any redirect or comment. Environment assignments are
  // dropped (the check is run with the gate's own environment).
  const head = cutAtShellOperator(segment.trim());
  const command = stripEnvAssignments(head);
  if (!CARGO_DENY_START.test(command)) return [];
  const source = `line ${no}`;
  const combinations = matrixCombinations(
    ctx.matrix,
    matrixKeys([command, ctx.wd ?? ""]),
    continueKeys(ctx.continueOnError),
  );
  const findings: CargoDenyCiFinding[] = [];
  for (const combination of combinations ?? [null]) {
    const text =
      (combination === null ? command : substituteMatrix(command, combination))
        .replace(WORKFLOW_EXPRESSION, "$EXPRESSION");
    const argv = tokeniseCommand(text);
    if (argv[0] !== "cargo" || argv[1] !== "deny") continue;
    const checkAt = argv.indexOf("check", 2);
    if (checkAt === -1) {
      // Without `check` a variable could still stand for it.
      if (argv.some((token) => UNRESOLVED.test(token))) {
        return [{
          kind: "unrunnable",
          source,
          reason: "the line uses a shell variable or workflow expression " +
            "($ or a backtick) in a cargo deny command that names no " +
            "`check`, so it cannot be run as CI runs it",
        }];
      }
      continue;
    }
    const wd = ctx.wd === undefined || combination === null
      ? ctx.wd
      : substituteMatrix(ctx.wd, combination);
    const cwd = resolveWorkingDirectory(wd);
    if (!cwd.ok) return [{ kind: "unrunnable", source, reason: cwd.reason }];
    findings.push({
      kind: "command",
      argv: dropUnresolved(argv),
      cwd: cwd.cwd,
      ...allowFailureFor(ctx, combination),
    });
  }
  return findings;
}

/**
 * The findings for one logical `run:` line. Every command segment is
 * examined, so `cargo fetch && cargo deny check` is found. A segment's `cd`
 * or other commands are ignored, and the step's working directory applies.
 */
function cargoDenyCommandFindings(
  line: string,
  no: number,
  ctx: StepContext,
): CargoDenyCiFinding[] {
  return splitShellSegments(line).flatMap((segment) =>
    segmentFindings(segment, no, ctx)
  );
}

/**
 * The findings for one `run:` key of a step. A block scalar gives one shell
 * line per YAML line. A plain value folds its lines into one, as YAML does.
 */
function runFindings(
  run: MappingLine,
  ctx: StepContext,
): CargoDenyCiFinding[] {
  const script: YamlLine[] = BLOCK_INDICATOR.test(scalarValue(run.raw))
    ? run.children
    : [{
      indent: 0,
      text: [
        scalarValue(run.raw),
        ...run.children.map((line) => line.text.trim()),
      ]
        .filter((part) => part !== "")
        .join(" "),
      no: run.no,
    }];
  const findings: CargoDenyCiFinding[] = [];
  let quote = "";
  for (const command of joinContinuations(script)) {
    const startsInQuote = quote !== "";
    for (let i = 0; i < command.text.length; i++) {
      const ch = command.text[i];
      if (ch === "\\" && quote !== "'") {
        i++;
        continue;
      }
      if (quote !== "") { if (ch === quote) quote = ""; }
      else if (ch === "'" || ch === '"') quote = ch;
      else if (
        ch === "#" && (i === 0 || /\s/.test(command.text[i - 1] ?? ""))
      ) break;
    }
    if (!startsInQuote) {
      findings.push(
        ...cargoDenyCommandFindings(command.text, command.no, ctx),
      );
    }
  }
  return findings;
}

/** The `with:` inputs of an action step, from its child lines. */
function parseWith(children: readonly YamlLine[]): Map<string, string> {
  const inputs = new Map<string, string>();
  const level = children[0]?.indent;
  for (const child of children) {
    if (child.indent !== level) continue;
    const mapping = parseMapping(child.text);
    if (mapping) inputs.set(mapping.key, scalarValue(mapping.raw));
  }
  return inputs;
}

/**
 * The argv the action builds from its inputs, run from the repo root. A
 * `${{ matrix.<key> }}` expression is expanded from the job's literal matrix,
 * one invocation per combination.
 */
function actionFindings(
  inputs: ReadonlyMap<string, string>,
  ctx: StepContext,
): CargoDenyCiFinding[] {
  const combinations = matrixCombinations(
    ctx.matrix,
    matrixKeys([...inputs.values()]),
    continueKeys(ctx.continueOnError),
  );
  return (combinations ?? [null]).flatMap((combination) =>
    actionVariantFindings(
      new Map(
        [...inputs].map(([name, value]) => [
          name,
          combination === null ? value : substituteMatrix(value, combination),
        ]),
      ),
      allowFailureFor(ctx, combination),
    )
  );
}

/**
 * One invocation of the action. An input that still holds a variable or
 * expression cannot be reproduced, so it takes the action's own default: the
 * command becomes a plain `check`, which runs every check and so covers every
 * subset the expression could select.
 */
function actionVariantFindings(
  inputs: ReadonlyMap<string, string>,
  allow: { allowFailure?: true },
): CargoDenyCiFinding[] {
  const value = (name: ActionInput): string => {
    const input = inputs.get(name) ?? ACTION_DEFAULTS[name];
    return UNRESOLVED.test(input) ? ACTION_DEFAULTS[name] : input;
  };
  return [{
    kind: "command",
    argv: [
      "cargo",
      "deny",
      "--log-level",
      value("log-level"),
      "--manifest-path",
      value("manifest-path"),
      ...splitWords(value("arguments")),
      ...splitWords(value("command")),
      ...splitWords(value("command-arguments")),
    ],
    cwd: ".",
    ...allow,
  }];
}

/** Direct children of `all[idx]`: deeper lines, up to the next key at `c`. */
function childrenOf(
  all: readonly YamlLine[],
  idx: number,
  c: number,
): YamlLine[] {
  const out: YamlLine[] = [];
  for (let j = idx + 1; j < all.length; j++) {
    const line = all[j];
    if (line === undefined || isSkippable(line.text)) continue;
    if (line.indent <= c) break;
    out.push(line);
  }
  return out;
}

/** The findings for one step, which spans lines `start` (the `- `) to `end`. */
function stepFindings(
  lines: readonly string[],
  start: number,
  end: number,
  dashIndent: number,
  job: JobContext,
): CargoDenyCiFinding[] {
  const afterDash = LIST_ITEM.exec(lines[start] ?? "")?.[2] ?? "";
  const content = afterDash.trimStart();
  const all: YamlLine[] = [];
  if (content !== "") {
    all.push({
      indent: dashIndent + 1 + (afterDash.length - content.length),
      text: content,
      no: start + 1,
    });
  }
  for (let k = start + 1; k < end; k++) {
    const text = lines[k] ?? "";
    all.push({ indent: indentOf(text), text, no: k + 1 });
  }
  // The step's own keys sit at one column: after `- ` when the key is on the
  // dash line, otherwise the first key line under a bare `-`.
  const c = content !== ""
    ? dashIndent + 1 + (afterDash.length - content.length)
    : (all.find((line) => !isSkippable(line.text))?.indent ?? -1);
  if (c <= dashIndent) return [];

  const keys: MappingLine[] = [];
  for (let idx = 0; idx < all.length; idx++) {
    const line = all[idx];
    if (line === undefined || line.indent !== c || isSkippable(line.text)) {
      continue;
    }
    const mapping = parseMapping(line.text);
    if (!mapping) continue;
    keys.push({
      ...mapping,
      no: line.no,
      children: childrenOf(all, idx, c),
    });
  }

  const find = (name: string): MappingLine | undefined =>
    keys.find((key) => key.key === name);
  // A step's own `working-directory` wins over the job's and the workflow's
  // `defaults.run.working-directory`, which apply to `run:` steps only.
  const wdKey = find("working-directory");
  const coeKey = find("continue-on-error");
  const ctx: StepContext = {
    matrix: job.matrix,
    wd: wdKey === undefined ? job.defaultWd : scalarValue(wdKey.raw),
    continueOnError: [
      ...(coeKey === undefined ? [] : [scalarValue(coeKey.raw)]),
      ...(job.continueOnError === undefined ? [] : [job.continueOnError]),
    ],
  };
  const findings: CargoDenyCiFinding[] = [];
  const usesKey = find("uses");
  if (usesKey !== undefined && ACTION_REPO.test(scalarValue(usesKey.raw))) {
    const withKey = find("with");
    findings.push(
      ...actionFindings(
        withKey === undefined ? new Map() : parseWith(withKey.children),
        ctx,
      ),
    );
  }
  for (const key of keys) {
    if (key.key === "run") findings.push(...runFindings(key, ctx));
  }
  return findings;
}

/** The parts of a parsed job this gate reads. */
interface ParsedJob {
  strategy?: { matrix?: Record<string, unknown> };
  defaults?: { run?: { "working-directory"?: unknown } };
  "continue-on-error"?: unknown;
}

/** A parsed YAML scalar as the text GitHub would see, or undefined. */
function yamlScalar(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ||
      typeof value === "boolean"
    ? String(value)
    : undefined;
}

/** The parts of a parsed workflow this gate reads. */
interface ParsedWorkflow {
  on?: unknown;
  defaults?: { run?: { "working-directory"?: unknown } };
}

/** The workflow as YAML parsed it, or null when it is not valid YAML. */
function parseWorkflow(text: string): ParsedWorkflow | null {
  try {
    const doc = parseYaml(text);
    return doc !== null && typeof doc === "object" && !Array.isArray(doc)
      ? doc as ParsedWorkflow
      : null;
  } catch {
    // GitHub does not run a workflow that is not valid YAML, so CI has no default to mirror.
    return null;
  }
}

/** What decides whether CI runs a workflow for a push: the paths and branches it carries. */
export interface WorkflowRunContext {
  /** Every path the branch's commits touch (deleted ones too); unknown means a path filter matches. */
  touched?: readonly string[];
  /** The branches pushed, without `refs/heads/`; unknown means a branch filter matches. */
  branches?: readonly string[];
}

/** The most characters of a `paths` or `branches` pattern the gate reads. */
const FILTER_PATTERN_CAP = 200;
/** The most `**` a pattern may hold: each can backtrack, so more is not read. */
const MAX_DOUBLE_STARS = 4;

/**
 * A GitHub filter pattern as a regex: `*` is any run but `/`, `**` any run,
 * `?` and `+` apply to the character before them, `[...]` is a class. Null
 * for a pattern the gate cannot read, which the caller treats as a match.
 */
function filterPatternRegex(pattern: string): RegExp | null {
  if (
    pattern.length > FILTER_PATTERN_CAP ||
    pattern.split("**").length > MAX_DOUBLE_STARS + 1
  ) return null;
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] ?? "";
    if (pattern.startsWith("**/", i)) {
      out += "(?:.*/)?";
      i += 2;
    } else if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i++;
      } else out += "[^/]*";
    } else if (ch === "?" || ch === "+") out += ch;
    else if (ch === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close === -1) return null;
      out += `[${pattern.slice(i + 1, close).replace(/\\/g, "\\\\")}]`;
      i = close;
    } else if (ch === "\\" && i + 1 < pattern.length) {
      i++;
      out += (pattern[i] ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return null;
  }
}

/**
 * Whether the filter patterns select `name`: the last pattern that matches
 * decides, and a leading `!` deselects. A pattern the gate cannot read selects.
 */
function filterSelects(patterns: readonly string[], name: string): boolean {
  let selected = false;
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!");
    const regex = filterPatternRegex(negated ? pattern.slice(1) : pattern);
    if (regex === null) return true;
    if (regex.test(name)) selected = !negated;
  }
  return selected;
}

function stringList(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? value as string[]
    : undefined;
}

/** Whether the names pass an include list and an ignore list (either may be absent). */
function namesPass(
  names: readonly string[] | undefined,
  include: string[] | undefined,
  ignore: string[] | undefined,
): boolean {
  if (names === undefined) return true;
  if (include !== undefined) {
    return names.some((name) => filterSelects(include, name));
  }
  if (ignore !== undefined) {
    return names.some((name) => !filterSelects(ignore, name));
  }
  return true;
}

/** One `on:` event's filters: an event with no mapping has none. */
function eventFilters(config: unknown): Record<string, unknown> {
  return config !== null && typeof config === "object" &&
      !Array.isArray(config)
    ? config as Record<string, unknown>
    : {};
}

/**
 * Whether CI can run the workflow for a push of these branches and paths:
 * it has a `pull_request`, `pull_request_target`, `merge_group` or
 * `workflow_call` trigger, or a `push` trigger whose branch filter matches;
 * and the trigger's `paths` / `paths-ignore` filter selects a touched path.
 * A `pull_request` `branches` filter is not read (the base branch is not
 * known here), so it matches. A workflow whose triggers cannot be read runs.
 */
function workflowRunsFor(
  workflow: ParsedWorkflow | null,
  context: WorkflowRunContext,
): boolean {
  const on = workflow === null
    ? undefined
    : workflow.on ?? (workflow as Record<string, unknown>)["true"];
  let events: Record<string, unknown>;
  if (typeof on === "string") events = { [on]: null };
  else if (Array.isArray(on)) {
    events = Object.fromEntries(on.map((event) => [String(event), null]));
  } else if (on !== null && typeof on === "object") {
    events = on as Record<string, unknown>;
  } else return true;
  const pathsPass = (filters: Record<string, unknown>) =>
    namesPass(
      context.touched,
      stringList(filters.paths),
      stringList(filters["paths-ignore"]),
    );
  return Object.entries(events).some(([event, config]) => {
    const filters = eventFilters(config);
    if (event === "pull_request" || event === "pull_request_target") {
      return pathsPass(filters);
    }
    if (event === "merge_group" || event === "workflow_call") return true;
    if (event !== "push") return false;
    const branches = stringList(filters.branches);
    const branchesIgnore = stringList(filters["branches-ignore"]);
    // A push filtered by tags alone does not run for a branch push.
    if (
      branches === undefined && branchesIgnore === undefined &&
      (filters.tags !== undefined || filters["tags-ignore"] !== undefined)
    ) return false;
    return namesPass(context.branches, branches, branchesIgnore) &&
      pathsPass(filters);
  });
}

/** A job of the workflow: its header line and the line after its last. */
interface JobBlock {
  header: number;
  end: number;
  indent: number;
}

/**
 * The jobs of the workflow: the direct children of the top-level `jobs:` key,
 * at whatever indent the file uses.
 */
function jobBlocks(lines: readonly string[]): JobBlock[] {
  const jobsAt = lines.findIndex((line) => /^jobs:\s*(?:#.*)?$/.test(line));
  if (jobsAt === -1) return [];
  const first = lines.slice(jobsAt + 1).find((line) =>
    !isSkippable(line) && indentOf(line) > 0
  );
  if (first === undefined) return [];
  const indent = indentOf(first);
  const blocks: JobBlock[] = [];
  for (let i = jobsAt + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isSkippable(line)) continue;
    if (indentOf(line) === 0) break;
    if (
      indentOf(line) !== indent ||
      !/^\s*(?:[\w-]+|"[^"]*"|'[^']*'):\s*(?:#.*)?$/.test(line)
    ) continue;
    let end = i + 1;
    while (
      end < lines.length &&
      (isSkippable(lines[end] ?? "") || indentOf(lines[end] ?? "") > indent)
    ) end++;
    blocks.push({ header: i, end, indent });
  }
  return blocks;
}

/**
 * Parse one workflow file's text into the cargo-deny invocations its steps
 * make. A step starts at a `- ` line and ends at the next non-blank line at
 * or below its dash's indent. Comment lines are ignored.
 *
 * A workflow CI cannot run for the push (see {@link workflowRunsFor}) has no
 * findings. A `run:` step without its own `working-directory` takes the job's,
 * then the workflow's, `defaults.run.working-directory`. A step's or job's
 * `continue-on-error` marks the invocations it allows to fail.
 *
 * SIMPLE-ON-PURPOSE: `exclude` entries of a matrix, `continue-on-error` tests other than a literal true or one matrix key, a `pull_request` `branches` filter, and script-hidden invocations are not read — upgrade when a cargo deny check run escapes this gate in practice or a workflow uses one of those forms.
 */
export function workflowCargoDenyFindings(
  text: string,
  context: WorkflowRunContext = {},
): CargoDenyCiFinding[] {
  const lines = text.split("\n").map((raw) => raw.replace(/\r$/, ""));
  const workflow = parseWorkflow(text);
  if (!workflowRunsFor(workflow, context)) return [];
  const findings: CargoDenyCiFinding[] = [];
  const workflowWd = yamlScalar(workflow?.defaults?.run?.["working-directory"]);
  const jobs = jobBlocks(lines);
  let start = 0;
  while (start < lines.length) {
    const item = LIST_ITEM.exec(lines[start] ?? "");
    const afterDash = item?.[2] ?? "";
    if (item === null || (afterDash !== "" && !/^\s/.test(afterDash))) {
      start++;
      continue;
    }
    const dashIndent = (item[1] ?? "").length;
    let end = start + 1;
    while (end < lines.length) {
      const line = lines[end] ?? "";
      if (!isSkippable(line) && indentOf(line) <= dashIndent) break;
      end++;
    }
    let job: JobContext = {
      matrix: {},
      defaultWd: workflowWd,
      continueOnError: undefined,
    };
    const block = jobs.findLast((candidate) =>
      candidate.header < start && start < candidate.end
    );
    if (block !== undefined) {
      try {
        const parsed = parseYaml(
          lines.slice(block.header, block.end).map((line) =>
            line.slice(block.indent)
          ).join("\n"),
        ) as Record<string, ParsedJob | null>;
        const parsedJob = Object.values(parsed)[0];
        job = {
          matrix: parsedJob?.strategy?.matrix ?? {},
          defaultWd:
            yamlScalar(parsedJob?.defaults?.run?.["working-directory"]) ??
              workflowWd,
          continueOnError: yamlScalar(parsedJob?.["continue-on-error"]),
        };
      } catch { /* Unsupported job syntax uses the full-check fallback. */ }
    }
    findings.push(...stepFindings(lines, start, end, dashIndent, job));
    start = end;
  }
  return findings;
}

/**
 * Locate the repository's cargo-deny invocations. Reads every tracked
 * `.github/workflows/*.yml|yaml`. A workflow that cannot be read is one
 * unrunnable finding naming that file (fail closed).
 */
export async function repoCargoDenyFindings(
  repoRoot: string,
  tracked: readonly string[],
  context: WorkflowRunContext = {},
): Promise<CargoDenyCiFinding[]> {
  const findings: CargoDenyCiFinding[] = [];
  for (const path of tracked) {
    if (!path.startsWith(".github/workflows/")) continue;
    if (!/\.ya?ml$/.test(path)) continue;
    let text: string;
    try {
      text = await Deno.readTextFile(`${repoRoot}/${path}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      findings.push({
        kind: "unrunnable",
        source: path,
        reason: `the workflow file could not be read (${detail}), so its ` +
          `cargo-deny steps cannot be checked`,
      });
      continue;
    }
    for (const finding of workflowCargoDenyFindings(text, context)) {
      findings.push(
        finding.kind === "unrunnable"
          ? { ...finding, source: `${path} ${finding.source}` }
          : finding,
      );
    }
  }
  return findings;
}

/**
 * Whether a push touches a file that changes the cargo-deny result: a
 * manifest, lock file, deny config, or cargo config.
 */
export function cargoDenyTriggered(changed: readonly string[]): boolean {
  return changed.some((path) => {
    const base = path.slice(path.lastIndexOf("/") + 1);
    return TRIGGER_BASENAMES.has(base) || TRIGGER_CARGO_CONFIG.test(path);
  });
}

/** The output split into lines, each capped at {@link LINE_CAP} characters. */
function outputLines(output: string): string[] {
  return output.split("\n").map((line) =>
    line.replace(/\r$/, "").slice(0, LINE_CAP)
  );
}

/** Redact URL credentials (`//user:token@` becomes `//***@`). */
function redactUrlCredentials(text: string): string {
  return text.replace(URL_CREDENTIALS, "//***@");
}

function infrastructure(cause: string): CargoDenyGateError {
  return {
    kind: "infrastructure",
    message: `${INFRA_PREFIX}"${redactUrlCredentials(cause)}"`,
  };
}

/**
 * Classify a failed cargo-deny run (Issue #4626).
 *
 * - `not-started` and `timeout` are infrastructure.
 * - `non-zero-exit` with an `error[code]` diagnostic is a verdict, whatever
 *   else the output says.
 * - `non-zero-exit` with a line that begins with a tool-unavailability
 *   message is infrastructure.
 * - Any other non-zero exit is a verdict (fail closed).
 */
export function classifyCargoDenyFailure(
  error: PreFlightGateError,
): CargoDenyGateError {
  const lines = outputLines(error.output);
  const firstLine = lines.find((line) => line.trim() !== "")?.trim();
  if (error.reason === "not-started") {
    return infrastructure(
      firstLine ?? "cargo deny could not be started (no error text captured)",
    );
  }
  if (error.reason === "timeout") {
    return infrastructure(
      firstLine ?? "cargo deny timed out (no output captured)",
    );
  }
  const verdict: CargoDenyGateError = {
    kind: "verdict",
    message: error.message,
  };
  if (lines.some((line) => VERDICT_LINE.test(line))) return verdict;
  const cause = lines.find((line) =>
    TOOL_UNAVAILABLE.some((re) => re.test(line.replace(LOG_PREFIX, "")))
  );
  if (cause !== undefined) return infrastructure(cause);
  return verdict;
}

/** Quote one argv entry for the pre-flight tokeniser, or null if impossible. */
export function quoteArg(value: string): string | null {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return null;
}

/**
 * Run the cargo-deny gate (Issue #4626). Intermediate pushes without cargo
 * inputs skip it unless `always` is set. The first failed check stops the gate.
 * An invocation CI allows to fail (`allowFailure`) runs after the others and
 * never stops the gate: its failure is a warning in the result, as it is
 * in CI. An identical invocation that CI does not allow to fail blocks.
 */
export async function runCargoDenyGate(opts: {
  cwd: string;
  changed: readonly string[];
  always?: boolean;
  tracked: readonly string[];
  runner?: PreFlightRunner;
  timeoutSeconds?: number;
  findings?: CargoDenyCiFinding[];
  /** The paths and branches that decide which workflows CI runs for this push. */
  context?: WorkflowRunContext;
}): Promise<
  Result<{ checksRun: string[]; warnings: string[] }, CargoDenyGateError>
> {
  if (!opts.always && !cargoDenyTriggered(opts.changed)) {
    return { ok: true, value: { checksRun: [], warnings: [] } };
  }
  const findings = opts.findings ??
    await repoCargoDenyFindings(opts.cwd, opts.tracked, opts.context);

  for (const finding of findings) {
    if (finding.kind === "unrunnable") {
      return {
        ok: false,
        error: {
          kind: "verdict",
          message: `cargo deny is part of this repository's CI but its ` +
            `invocation cannot be reproduced locally (${finding.source}: ` +
            `${finding.reason}) — the push is blocked, not waved through`,
        },
      };
    }
  }

  const checks = new Map<
    string,
    { command: string; cwd: string; allowFailure: boolean }
  >();
  for (const finding of findings) {
    if (finding.kind !== "command") continue;
    const key = JSON.stringify([finding.argv, finding.cwd]);
    const allowFailure = finding.allowFailure === true;
    const seen = checks.get(key);
    if (seen !== undefined) {
      seen.allowFailure = seen.allowFailure && allowFailure;
      continue;
    }
    const parts: string[] = [];
    for (const arg of finding.argv) {
      const quoted = quoteArg(arg);
      if (quoted === null) {
        return {
          ok: false,
          error: {
            kind: "verdict",
            message: `cargo deny argument ${JSON.stringify(arg)} contains ` +
              `both ' and " and cannot be quoted for the pre-flight runner ` +
              `— the push is blocked, not waved through`,
          },
        };
      }
      parts.push(quoted);
    }
    checks.set(key, {
      command: parts.join(" "),
      cwd: finding.cwd === "." ? opts.cwd : `${opts.cwd}/${finding.cwd}`,
      allowFailure,
    });
  }

  const checksRun: string[] = [];
  const warnings: string[] = [];
  const ordered = [...checks.values()];
  for (
    const check of [
      ...ordered.filter((item) => !item.allowFailure),
      ...ordered.filter((item) => item.allowFailure),
    ]
  ) {
    const result = await runPreFlightGate([check.command], {
      cwd: check.cwd,
      runner: opts.runner,
      timeoutSeconds: opts.timeoutSeconds,
    });
    if (!result.ok) {
      const error = classifyCargoDenyFailure(result.error);
      if (!check.allowFailure) return { ok: false, error };
      warnings.push(
        `${check.command} failed, which CI allows (continue-on-error), so ` +
          `the push is not blocked: ${error.message.slice(0, WARNING_CAP)}`,
      );
      continue;
    }
    checksRun.push(check.command);
  }
  return { ok: true, value: { checksRun, warnings } };
}
