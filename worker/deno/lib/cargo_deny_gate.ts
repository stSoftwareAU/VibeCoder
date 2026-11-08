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
 * never a pass and never a verdict. Any other non-zero exit is a verdict.
 *
 * The gate never adds `--offline`, an ignore list or a reduced-scope flag.
 * A `${{ matrix.<key> }}` expression is expanded from the job's literal
 * matrix, one invocation per combination. An expression that cannot be
 * expanded falls back to a plain `check` (every check, so every subset) with
 * the action's defaults, except in a `run:` line before `check`, which stays
 * unrunnable.
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
  | { kind: "command"; argv: string[]; cwd: string }
  | { kind: "unrunnable"; source: string; reason: string };

/** A cargo-deny gate failure: a real verdict, or the tool could not run. */
export type CargoDenyGateError = {
  kind: "verdict" | "infrastructure";
  message: string;
};

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

/**
 * The value of each of `keys` in every combination of the job's literal
 * `strategy.matrix`: the lists cross, each `include` entry adds to the
 * combinations it matches or is its own combination, and `exclude` is not
 * applied (an excluded combination is checked too, which is stricter). Null
 * when a key has no literal value in some combination, a value is not a plain
 * scalar, or there are too many combinations: the caller then falls back to a
 * plain `check`.
 */
function matrixCombinations(
  matrix: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string>[] | null {
  if (keys.length === 0) return [{}];
  const dimensions = Object.entries(matrix).filter(([key, value]) =>
    key !== "include" && key !== "exclude" && Array.isArray(value)
  );
  let combinations: Record<string, string>[] = dimensions.length === 0
    ? []
    : [{}];
  for (const [key, list] of dimensions) {
    if (!keys.includes(key)) continue;
    const values = (list as unknown[]).map(matrixScalar);
    if (values.length === 0 || values.some((value) => value === undefined)) {
      return null;
    }
    combinations = combinations.flatMap((combination) =>
      values.map((value) => ({ ...combination, [key]: value as string }))
    );
    if (combinations.length > MAX_MATRIX_COMBINATIONS) return null;
  }
  const includes = Array.isArray(matrix.include) ? matrix.include : [];
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
    if (!matched && keys.some((key) => values[key] !== undefined)) {
      combinations.push(values);
    }
  }
  if (combinations.length > MAX_MATRIX_COMBINATIONS) return null;
  const seen = new Set<string>();
  const result: Record<string, string>[] = [];
  for (const combination of combinations) {
    const picked: Record<string, string> = {};
    for (const key of keys) {
      const value = combination[key];
      if (value === undefined || !SAFE_MATRIX_VALUE.test(value)) return null;
      picked[key] = value;
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

/**
 * The findings for one command segment of a shell line. A `${{ matrix.<key> }}`
 * expression is expanded from the job's literal matrix, one invocation per
 * combination. A variable or expression that stays after `check` is dropped,
 * so the invocation runs a plain `check`, which covers every subset a matrix
 * could select. One before `check`, or in a command that names no `check`,
 * could change what is checked, so that is unrunnable.
 */
function segmentFindings(
  segment: string,
  no: number,
  wd: string | undefined,
  matrix: Record<string, unknown>,
): CargoDenyCiFinding[] {
  // The text before any redirect or comment, environment assignments included.
  const head = cutAtShellOperator(segment.trim());
  const command = stripEnvAssignments(head);
  if (!CARGO_DENY_START.test(command)) return [];
  const source = `line ${no}`;
  const unrunnable = (): CargoDenyCiFinding[] => [{
    kind: "unrunnable",
    source,
    reason: "the line uses a shell variable or workflow expression " +
      "($ or a backtick) that cannot be resolved, so it cannot be run as " +
      "CI runs it",
  }];
  // An environment assignment with a variable or expression cannot be
  // reproduced.
  if (UNRESOLVED.test(head.slice(0, head.length - command.length))) {
    return unrunnable();
  }
  const combinations = matrixCombinations(matrix, matrixKeys([command]));
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
      if (argv.some((token) => UNRESOLVED.test(token))) return unrunnable();
      continue;
    }
    if (argv.slice(0, checkAt).some((token) => UNRESOLVED.test(token))) {
      return unrunnable();
    }
    const cwd = resolveWorkingDirectory(wd);
    if (!cwd.ok) return [{ kind: "unrunnable", source, reason: cwd.reason }];
    findings.push({
      kind: "command",
      argv: argv.filter((token, i) => i <= checkAt || !UNRESOLVED.test(token)),
      cwd: cwd.cwd,
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
  wd: string | undefined,
  matrix: Record<string, unknown>,
): CargoDenyCiFinding[] {
  return splitShellSegments(line).flatMap((segment) =>
    segmentFindings(segment, no, wd, matrix)
  );
}

/**
 * The findings for one `run:` key of a step. A block scalar gives one shell
 * line per YAML line. A plain value folds its lines into one, as YAML does.
 */
function runFindings(
  run: MappingLine,
  wd: string | undefined,
  matrix: Record<string, unknown>,
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
        ...cargoDenyCommandFindings(command.text, command.no, wd, matrix),
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
  matrix: Record<string, unknown>,
): CargoDenyCiFinding[] {
  const combinations = matrixCombinations(
    matrix,
    matrixKeys([...inputs.values()]),
  );
  return (combinations ?? [null]).flatMap((combination) =>
    actionVariantFindings(
      new Map(
        [...inputs].map(([name, value]) => [
          name,
          combination === null ? value : substituteMatrix(value, combination),
        ]),
      ),
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
  matrix: Record<string, unknown>,
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
  const wdKey = find("working-directory");
  const wd = wdKey === undefined ? undefined : scalarValue(wdKey.raw);
  const findings: CargoDenyCiFinding[] = [];
  const usesKey = find("uses");
  if (usesKey !== undefined && ACTION_REPO.test(scalarValue(usesKey.raw))) {
    const withKey = find("with");
    findings.push(
      ...actionFindings(
        withKey === undefined ? new Map() : parseWith(withKey.children),
        matrix,
      ),
    );
  }
  for (const key of keys) {
    if (key.key === "run") findings.push(...runFindings(key, wd, matrix));
  }
  return findings;
}

/**
 * Parse one workflow file's text into the cargo-deny invocations its steps
 * make. A step starts at a `- ` line and ends at the next non-blank line at
 * or below its dash's indent. Comment lines are ignored.
 *
 * SIMPLE-ON-PURPOSE: job- or workflow-level `defaults.run.working-directory`, `exclude` entries of a matrix and script-hidden invocations are not read — upgrade when a cargo deny check run escapes this gate in practice or a workflow uses one of those forms.
 */
export function workflowCargoDenyFindings(text: string): CargoDenyCiFinding[] {
  const lines = text.split("\n").map((raw) => raw.replace(/\r$/, ""));
  const findings: CargoDenyCiFinding[] = [];
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
    let matrix: Record<string, unknown> = {};
    try {
      const jobLine = lines.slice(0, start).findLastIndex((line) =>
        /^ {2}[\w-]+:\s*(?:#.*)?$/.test(line)
      );
      if (jobLine >= 0) {
        let jobEnd = jobLine + 1;
        while (
          jobEnd < lines.length &&
          (isSkippable(lines[jobEnd] ?? "") ||
            indentOf(lines[jobEnd] ?? "") > 2)
        ) jobEnd++;
        const parsed = parseYaml(
          lines.slice(jobLine, jobEnd).map((line) => line.slice(2)).join("\n"),
        ) as Record<
          string,
          { strategy?: { matrix?: Record<string, unknown> } }
        >;
        matrix = Object.values(parsed)[0]?.strategy?.matrix ?? {};
      }
    } catch { /* Unsupported job syntax uses the full-check fallback. */ }
    findings.push(...stepFindings(lines, start, end, dashIndent, matrix));
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
    for (const finding of workflowCargoDenyFindings(text)) {
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
 */
export async function runCargoDenyGate(opts: {
  cwd: string;
  changed: readonly string[];
  always?: boolean;
  tracked: readonly string[];
  runner?: PreFlightRunner;
  timeoutSeconds?: number;
  findings?: CargoDenyCiFinding[];
}): Promise<Result<{ checksRun: string[] }, CargoDenyGateError>> {
  if (!opts.always && !cargoDenyTriggered(opts.changed)) {
    return { ok: true, value: { checksRun: [] } };
  }
  const findings = opts.findings ??
    await repoCargoDenyFindings(opts.cwd, opts.tracked);

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

  const seen = new Set<string>();
  const checks: { command: string; cwd: string }[] = [];
  for (const finding of findings) {
    if (finding.kind !== "command") continue;
    const key = JSON.stringify([finding.argv, finding.cwd]);
    if (seen.has(key)) continue;
    seen.add(key);
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
    checks.push({
      command: parts.join(" "),
      cwd: finding.cwd === "." ? opts.cwd : `${opts.cwd}/${finding.cwd}`,
    });
  }

  const checksRun: string[] = [];
  for (const check of checks) {
    const result = await runPreFlightGate([check.command], {
      cwd: check.cwd,
      runner: opts.runner,
      timeoutSeconds: opts.timeoutSeconds,
    });
    if (!result.ok) {
      return { ok: false, error: classifyCargoDenyFailure(result.error) };
    }
    checksRun.push(check.command);
  }
  return { ok: true, value: { checksRun } };
}
