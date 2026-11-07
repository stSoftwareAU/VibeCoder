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
 * The gate never adds `--offline`, an ignore list or any reduced-scope flag:
 * it runs exactly the argv CI runs.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
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

/** The findings for one command segment of a shell line. */
function segmentFindings(
  segment: string,
  no: number,
  wd: string | undefined,
): CargoDenyCiFinding[] {
  // The text before any redirect or comment, environment assignments included.
  const head = cutAtShellOperator(segment.trim());
  const command = stripEnvAssignments(head);
  if (!CARGO_DENY_START.test(command)) return [];
  const source = `line ${no}`;
  // A cargo deny segment with a shell variable or expression cannot be
  // reproduced, whether or not it names `check`.
  if (head.includes("$") || head.includes("`")) {
    return [{
      kind: "unrunnable",
      source,
      reason: "the line uses a shell variable or workflow expression " +
        "($ or a backtick), so it cannot be run as CI runs it",
    }];
  }
  const argv = tokeniseCommand(command);
  if (
    argv[0] !== "cargo" || argv[1] !== "deny" ||
    !argv.slice(2).includes("check")
  ) {
    return [];
  }
  const cwd = resolveWorkingDirectory(wd);
  if (!cwd.ok) return [{ kind: "unrunnable", source, reason: cwd.reason }];
  return [{ kind: "command", argv, cwd: cwd.cwd }];
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
): CargoDenyCiFinding[] {
  return splitShellSegments(line).flatMap((segment) =>
    segmentFindings(segment, no, wd)
  );
}

/**
 * The findings for one `run:` key of a step. A block scalar gives one shell
 * line per YAML line. A plain value folds its lines into one, as YAML does.
 */
function runFindings(
  run: MappingLine,
  wd: string | undefined,
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
  for (const command of joinContinuations(script)) {
    findings.push(...cargoDenyCommandFindings(command.text, command.no, wd));
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

/** The argv the action builds from its inputs, run from the repo root. */
function actionFindings(
  inputs: ReadonlyMap<string, string>,
  no: number,
): CargoDenyCiFinding[] {
  const value = (name: ActionInput): string =>
    inputs.get(name) ?? ACTION_DEFAULTS[name];
  for (const name of Object.keys(ACTION_DEFAULTS) as ActionInput[]) {
    if (value(name).includes("$")) {
      return [{
        kind: "unrunnable",
        source: `line ${no}`,
        reason: `the cargo-deny-action input ${name} uses a shell variable ` +
          `or workflow expression, so it cannot be run as CI runs it`,
      }];
    }
  }
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
      value("command"),
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
        usesKey.no,
      ),
    );
  }
  for (const key of keys) {
    if (key.key === "run") findings.push(...runFindings(key, wd));
  }
  return findings;
}

/**
 * Parse one workflow file's text into the cargo-deny invocations its steps
 * make. A step starts at a `- ` line and ends at the next non-blank line at
 * or below its dash's indent. Comment lines are ignored.
 *
 * SIMPLE-ON-PURPOSE: job- or workflow-level `defaults.run.working-directory`, matrix expansion and script-hidden invocations are not read — upgrade when a cargo deny check run escapes this gate in practice or a workflow uses one of those forms.
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
    findings.push(...stepFindings(lines, start, end, dashIndent));
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
function quoteArg(value: string): string | null {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return null;
}

/**
 * Run the cargo-deny gate (Issue #4626). A change that touches no cargo input
 * passes with nothing run. Otherwise every CI invocation runs in order, with
 * CI's exact argv, and the first failure stops the gate.
 */
export async function runCargoDenyGate(opts: {
  cwd: string;
  changed: readonly string[];
  tracked: readonly string[];
  runner?: PreFlightRunner;
  timeoutSeconds?: number;
  findings?: CargoDenyCiFinding[];
}): Promise<Result<{ checksRun: string[] }, CargoDenyGateError>> {
  if (!cargoDenyTriggered(opts.changed)) {
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
