/**
 * Versioned summary-facts schema (Issue #3534, part of #3396).
 *
 * The facts are structured JSON from which the PR summary's Branch outcomes
 * block is rendered. The validator rejects anything it does not understand
 * (unknown keys, wrong types, over-cap values, unsafe paths), and the rendered
 * Markdown round-trips through `parseBranchOutcomes`.
 *
 * Pure: no IO. Every validation error reads `<field path>: <reason>`. Hostile
 * key text is never echoed verbatim: keys are capped and JSON-quoted.
 *
 * Australian English spelling used throughout.
 */

import type { Result } from "../types.ts";
import {
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  reasonWordCount,
} from "./branch_outcomes_gate.ts";
import { isTestFilePath } from "./security_fix_gate.ts";

/** The only schema version this module understands. */
export const SUMMARY_FACTS_VERSION = 1;

/**
 * Cap on the raw facts input, checked on `raw.length` before `JSON.parse`.
 * Keeps the rendered list well inside the parser's `MAX_SCAN_CHARS`.
 */
export const MAX_FACTS_CHARS = 100_000;

/** Cap on each free-text field. */
export const MAX_FIELD_CHARS = 1_000;

/** Cap on a path (parity with the prose parser's token cap). */
export const MAX_PATH_CHARS = 300;

/** Why an outcome is exempt from needing a test. */
export type ExemptKind = "out-of-scope" | "untestable";

/** An outcome reached by a named test that was seen to fail first. */
export interface TestedEntry {
  path: string;
  line: number;
  endLine?: number;
  outcome: string;
  test: string;
  testName: string;
  flipWentRed: string;
}

/** An outcome exempted with a stated reason. */
export interface ExemptEntry {
  path: string;
  line: number;
  endLine?: number;
  outcome: string;
  exempt: { kind: ExemptKind; reason: string };
}

/** One Branch outcomes entry: either tested or exempt. */
export type BranchOutcomeEntry = TestedEntry | ExemptEntry;

/** The versioned summary facts. */
export interface SummaryFacts {
  version: 1;
  branchOutcomes: { noneAdded: boolean; entries: BranchOutcomeEntry[] };
}

const PATH_CHARSET_RE = /^[A-Za-z0-9_.\-\/]+$/;
const EXTENSION_RE = /\.[A-Za-z0-9]+$/;
// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const LINE_BREAK_RE = /[\r\n\u2028\u2029]/;
const BACKTICK_RUN_RE = /`+/g;
const MAX_KEY_ECHO_CHARS = 64;

type Check<T> = { ok: true; value: T } | { ok: false; error: Error };

function fail(path: string, reason: string): { ok: false; error: Error } {
  return { ok: false, error: new Error(`${path}: ${reason}`) };
}

function keyPath(path: string, key: string): string {
  return `${path}[${JSON.stringify(key.slice(0, MAX_KEY_ECHO_CHARS))}]`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** First unknown key in `obj` as an error, or null. */
function unknownKey(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): { ok: false; error: Error } | null {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) return fail(keyPath(path, key), "unknown key");
  }
  return null;
}

function checkObject(
  value: unknown,
  path: string,
): Check<Record<string, unknown>> {
  if (!isPlainObject(value)) return fail(path, "expected an object");
  return { ok: true, value };
}

/** Shared repo-relative path rules, each rejection with its own reason. */
function checkPath(value: unknown, path: string): Check<string> {
  if (typeof value !== "string") return fail(path, "expected a string");
  if (value.length === 0) return fail(path, "must not be empty");
  if (value.length > MAX_PATH_CHARS) {
    return fail(path, `exceeds ${MAX_PATH_CHARS} chars`);
  }
  if (!PATH_CHARSET_RE.test(value)) {
    return fail(path, "contains characters outside [A-Za-z0-9_.-/]");
  }
  if (value.startsWith("/")) return fail(path, "must be repo-relative");
  const segments = value.split("/");
  if (segments.includes("..")) {
    return fail(path, "must not contain a .. segment");
  }
  if (segments.includes("")) {
    return fail(path, "must not contain an empty segment");
  }
  return { ok: true, value };
}

function checkTestPath(value: unknown, path: string): Check<string> {
  const checked = checkPath(value, path);
  if (!checked.ok) return checked;
  if (!isTestFilePath(checked.value)) return fail(path, "not a test file path");
  if (!EXTENSION_RE.test(checked.value)) {
    return fail(path, "must end with a file extension");
  }
  return checked;
}

function checkLine(value: unknown, path: string): Check<number> {
  if (typeof value !== "number") return fail(path, "expected a number");
  if (!Number.isSafeInteger(value) || value < 1) {
    return fail(path, "must be a positive integer");
  }
  return { ok: true, value };
}

function checkText(
  value: unknown,
  path: string,
  requireNonEmpty: boolean,
): Check<string> {
  if (typeof value !== "string") return fail(path, "expected a string");
  if (value.length > MAX_FIELD_CHARS) {
    return fail(path, `exceeds ${MAX_FIELD_CHARS} chars`);
  }
  if (LINE_BREAK_RE.test(value)) return fail(path, "must be a single line");
  if (requireNonEmpty && value.trim().length === 0) {
    return fail(path, "must not be empty");
  }
  return { ok: true, value };
}

const ENTRY_KEYS = [
  "path",
  "line",
  "endLine",
  "outcome",
  "test",
  "testName",
  "flipWentRed",
  "exempt",
] as const;
const TEST_KEYS = ["test", "testName", "flipWentRed"] as const;

function checkExempt(
  value: unknown,
  path: string,
): Check<{ kind: ExemptKind; reason: string }> {
  const obj = checkObject(value, path);
  if (!obj.ok) return obj;
  const unknown = unknownKey(obj.value, ["kind", "reason"], path);
  if (unknown) return unknown;
  for (const key of ["kind", "reason"]) {
    if (!has(obj.value, key)) return fail(`${path}.${key}`, "required");
  }
  const kind = obj.value.kind;
  if (kind !== "out-of-scope" && kind !== "untestable") {
    return fail(`${path}.kind`, 'must be "out-of-scope" or "untestable"');
  }
  const reason = checkText(obj.value.reason, `${path}.reason`, false);
  if (!reason.ok) return reason;
  if (reasonWordCount(reason.value) < 3) {
    return fail(`${path}.reason`, "needs at least 3 words");
  }
  return { ok: true, value: { kind, reason: reason.value } };
}

function checkEntry(value: unknown, path: string): Check<BranchOutcomeEntry> {
  const obj = checkObject(value, path);
  if (!obj.ok) return obj;
  const e = obj.value;
  const unknown = unknownKey(e, ENTRY_KEYS, path);
  if (unknown) return unknown;

  const hasExempt = has(e, "exempt");
  const hasTest = TEST_KEYS.some((key) => has(e, key));
  if (hasExempt && hasTest) {
    return fail(
      path,
      "give either test, testName and flipWentRed or exempt, not both",
    );
  }
  if (!hasExempt && !hasTest) {
    return fail(path, "give either test, testName and flipWentRed or exempt");
  }
  for (const key of ["path", "line", "outcome"]) {
    if (!has(e, key)) return fail(`${path}.${key}`, "required");
  }
  if (hasTest) {
    for (const key of TEST_KEYS) {
      if (!has(e, key)) return fail(`${path}.${key}`, "required");
    }
  }

  const entryPath = checkPath(e.path, `${path}.path`);
  if (!entryPath.ok) return entryPath;
  const line = checkLine(e.line, `${path}.line`);
  if (!line.ok) return line;
  let endLine: number | undefined;
  if (has(e, "endLine")) {
    const checked = checkLine(e.endLine, `${path}.endLine`);
    if (!checked.ok) return checked;
    if (checked.value < line.value) {
      return fail(`${path}.endLine`, "must not be less than line");
    }
    endLine = checked.value;
  }
  const outcome = checkText(e.outcome, `${path}.outcome`, true);
  if (!outcome.ok) return outcome;

  const base = {
    path: entryPath.value,
    line: line.value,
    ...(endLine === undefined ? {} : { endLine }),
    outcome: outcome.value,
  };
  let entry: BranchOutcomeEntry;
  if (hasExempt) {
    const exempt = checkExempt(e.exempt, `${path}.exempt`);
    if (!exempt.ok) return exempt;
    entry = { ...base, exempt: exempt.value };
  } else {
    const test = checkTestPath(e.test, `${path}.test`);
    if (!test.ok) return test;
    const testName = checkText(e.testName, `${path}.testName`, true);
    if (!testName.ok) return testName;
    const flip = checkText(e.flipWentRed, `${path}.flipWentRed`, true);
    if (!flip.ok) return flip;
    entry = {
      ...base,
      test: test.value,
      testName: testName.value,
      flipWentRed: flip.value,
    };
  }
  if (renderEntry(entry).length > MAX_ENTRY_CHARS) {
    return fail(path, `rendered entry exceeds ${MAX_ENTRY_CHARS} chars`);
  }
  return { ok: true, value: entry };
}

function checkBranchOutcomes(
  value: unknown,
): Check<SummaryFacts["branchOutcomes"]> {
  const path = "branchOutcomes";
  const obj = checkObject(value, path);
  if (!obj.ok) return obj;
  const unknown = unknownKey(obj.value, ["noneAdded", "entries"], path);
  if (unknown) return unknown;
  for (const key of ["noneAdded", "entries"]) {
    if (!has(obj.value, key)) return fail(`${path}.${key}`, "required");
  }
  const { noneAdded, entries } = obj.value;
  if (typeof noneAdded !== "boolean") {
    return fail(
      `${path}.noneAdded`,
      "expected a boolean",
    );
  }
  if (!Array.isArray(entries)) {
    return fail(
      `${path}.entries`,
      "expected an array",
    );
  }
  if (entries.length > MAX_ENTRIES) {
    return fail(`${path}.entries`, `exceeds ${MAX_ENTRIES} entries`);
  }
  if (noneAdded && entries.length > 0) {
    return fail(`${path}.noneAdded`, "true requires no entries");
  }
  if (!noneAdded && entries.length === 0) {
    return fail(`${path}.noneAdded`, "false requires at least one entry");
  }
  const checked: BranchOutcomeEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = checkEntry(entries[i], `${path}.entries[${i}]`);
    if (!entry.ok) return entry;
    checked.push(entry.value);
  }
  return { ok: true, value: { noneAdded, entries: checked } };
}

/**
 * Parse and validate raw summary-facts JSON. Returns a freshly built object
 * holding only known fields, or the first error found.
 */
export function parseSummaryFacts(raw: string): Result<SummaryFacts> {
  if (typeof raw !== "string") return fail("facts", "expected a string");
  if (raw.length > MAX_FACTS_CHARS) {
    return fail("facts", `exceeds ${MAX_FACTS_CHARS} chars`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("facts", "invalid JSON");
  }
  const top = checkObject(parsed, "facts");
  if (!top.ok) return top;
  const unknown = unknownKey(top.value, ["version", "branchOutcomes"], "facts");
  if (unknown) return unknown;
  for (const key of ["version", "branchOutcomes"]) {
    if (!has(top.value, key)) return fail(key, "required");
  }
  if (top.value.version !== SUMMARY_FACTS_VERSION) {
    return fail(
      "version",
      `unsupported version (expected ${SUMMARY_FACTS_VERSION})`,
    );
  }
  const outcomes = checkBranchOutcomes(top.value.branchOutcomes);
  if (!outcomes.ok) return outcomes;
  return {
    ok: true,
    value: { version: SUMMARY_FACTS_VERSION, branchOutcomes: outcomes.value },
  };
}

/** Replace control and line-break characters with spaces. */
function sanitise(text: string): string {
  return text.replace(CONTROL_RE, " ");
}

/**
 * Wrap text in a backtick code span whose fence is one longer than the
 * longest backtick run inside, padded with a space when the text starts or
 * ends with a backtick, so the content can never close the span.
 */
function codeSpan(text: string): string {
  const clean = sanitise(text);
  let longest = 0;
  for (const match of clean.matchAll(BACKTICK_RUN_RE)) {
    if (match[0].length > longest) longest = match[0].length;
  }
  const fence = "`".repeat(longest + 1);
  const pad = clean.startsWith("`") || clean.endsWith("`") ? " " : "";
  return `${fence}${pad}${clean}${pad}${fence}`;
}

/**
 * Render free text as plain (unspanned) Markdown-safe text. The prose gate
 * blanks any code span containing whitespace before reading the exemption
 * reason, so the reason must stay outside a span. Backticks become
 * apostrophes and `<` becomes `&lt;` so the text can neither open a span nor
 * start an HTML comment that would swallow the bullets after it. The sink is
 * Markdown, not an HTML DOM, so the escape targets only the two characters
 * that can open a code span or HTML comment (pinned by tests).
 */
function plainText(text: string): string {
  // Markdown sink, not HTML: escaping only backtick and < is intentional.
  // nosemgrep: javascript.audit.detect-replaceall-sanitization.detect-replaceall-sanitization
  return sanitise(text).replaceAll("`", "'").replaceAll("<", "&lt;").trim();
}

function renderEntry(entry: BranchOutcomeEntry): string {
  const range = entry.endLine === undefined
    ? `${entry.line}`
    : `${entry.line}-${entry.endLine}`;
  const loc = codeSpan(`${entry.path}:${range}`);
  const head = `- ${loc} — ${codeSpan(entry.outcome)} — `;
  if ("exempt" in entry) {
    const label = entry.exempt.kind === "untestable"
      ? "untestable"
      : "out of scope";
    return `${head}exempt (${label}): ${plainText(entry.exempt.reason)}`;
  }
  return `${head}test ${codeSpan(entry.test)} (${
    codeSpan(entry.testName)
  }) — ` +
    `flip: ${codeSpan(entry.flipWentRed)}`;
}

/**
 * Render the Branch outcomes block. Deterministic; no trailing newline.
 * `noneAdded` renders exactly `Branch outcomes: none added`.
 */
export function renderBranchOutcomes(facts: SummaryFacts): string {
  const { noneAdded, entries } = facts.branchOutcomes;
  if (noneAdded) return "Branch outcomes: none added";
  return "**Branch outcomes:**\n\n" + entries.map(renderEntry).join("\n");
}

/**
 * De-duplicated declared `test` paths in first-seen order. The prose parser's
 * `namedTestPaths` also picks up any test-shaped path in free text or in
 * `path`, so this list is the declared tests, a subset of what the parser may
 * name.
 */
export function namedTestPathsFromFacts(facts: SummaryFacts): string[] {
  const seen = new Set<string>();
  for (const entry of facts.branchOutcomes.entries) {
    if ("test" in entry) seen.add(entry.test);
  }
  return [...seen];
}
