/**
 * Every lib module that fences or scrubs text and exports a `parse*` reply
 * parser is either an echo-table row or an allowlist entry (Issue #4211).
 *
 * The scanner is pure: it sees only the path-to-source map the test hands
 * it. Comments and string literals cannot invent an import or a parser.
 *
 * Uses Australian English throughout (behaviour, artefact).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { sourceProseLines } from "../lib/doc_prose_scope.ts";
import { ECHO_TABLE_MODULES } from "./echo_round_trip_test.ts";

/** Names that make a module an echo-consumer candidate. */
const ECHO_HELPERS = new Set([
  "scrubUntrustedText",
  "fenceUntrustedIssueText",
  "createPromptDelimiters",
]);

/** A scanned module that is not an echo-table row, with why. */
export interface EchoAllowlistEntry {
  module: string;
  reason: string;
}

/**
 * The scanned modules that are not echo-table rows, each with the reason it
 * does not take a model's copy of fenced text as the original. A module that
 * is an echo consumer belongs in ECHO_TABLE_MODULES instead.
 */
export const ECHO_ALLOWLIST: readonly EchoAllowlistEntry[] = [
  {
    module: "ci_failure_issue.ts",
    reason:
      "parseCiFailureBuildReference reads a build URL or build number from an issue body. createPromptDelimiters fences log text when the issue is filed; the parser does not treat a model's copy of that fence as the original.",
  },
  {
    module: "clarity_assessment.ts",
    reason:
      "parseClarityAssessmentOutput classifies the reply as CLEAR or as clarifying questions. It does not match that reply against the fenced issue text or write the fenced text back.",
  },
  {
    module: "failure_detection_repair.ts",
    reason:
      "parseBatchRepairOutput splits the model's drafted Failure Detection sections on the batch markers. The prompt asks for a new section, and the parser does not match that draft against the fenced sub-issue body.",
  },
  {
    module: "pre_pr_verifier.ts",
    reason:
      "parseReviewReply reads the review JSON. Closure echoes are matched by closureGapFindings in closure_met_check.ts, and caller echoes by callerGapFindings in caller_checks.ts. This parser does not compare a fenced copy with a stored original or write one back.",
  },
  {
    module: "pr_feedback_drift_check.ts",
    reason:
      "parseDriftVerdict reads the model's findings, then sentenceFoundIn matches each quote with normaliseWhitespace(content).includes against the file read by path, not against the fenced copy.",
  },
  {
    module: "quorum_orchestrator.ts",
    reason:
      "parseQuorumVerdict reads a winner of A or B, plus reasoning and scores, from the judge's JSON block. It does not match fenced plan text or write it back in place of an original.",
  },
  {
    module: "references_refresh.ts",
    reason:
      "parseRefreshState and parseKnownGapRows read the sweep's state file and the gh issue list. fenceUntrustedIssueText only wraps source detail in the suggestion issue filed for a human; nothing parses a model's copy of that fence.",
  },
  {
    module: "refinement_processor.ts",
    reason:
      "parseRefinementResponse reads a JSON rewrite (new_title and new_body). The worker publishes that rewrite after redactSecrets. It does not match the reply against the fenced issue text.",
  },
  {
    module: "revision_processor.ts",
    reason:
      "parseRevisionResponse reads a JSON rewrite (new_title and new_body). The worker publishes that rewrite after redactSecrets. It does not match the reply against the fenced issue text.",
  },
];

function codeOnly(source: string, path: string): string {
  const lexed = sourceProseLines(source, path);
  if (lexed.unterminatedFrom !== -1) {
    throw new Error(
      `${path}: source could not be scanned completely; fix the parse before checking echo consumers`,
    );
  }
  const originalLines = source.split("\n");
  return lexed.lines.map((line, index) =>
    line.code.padEnd(originalLines[index]!.length)
  ).join("\n");
}

function importsEchoHelper(source: string, path: string): boolean {
  const code = codeOnly(source, path);
  const statement = /\bimport\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+/g;
  for (const match of code.matchAll(statement)) {
    if (match[1]) continue;
    const fromAt = (match.index ?? 0) + match[0].length;
    const specifier = source.slice(fromAt).match(/^\s*["']([^"']+)["']/);
    if (!specifier?.[1]?.endsWith("prompt_delimiter.ts")) continue;
    const names = match[2] ?? "";
    for (const part of names.split(",")) {
      const spec = part.trim();
      if (spec === "" || spec.startsWith("type ")) continue;
      const original = spec.split(/\s+as\s+/)[0]!.trim();
      if (ECHO_HELPERS.has(original)) return true;
    }
  }
  return false;
}

function exportsParseFunction(source: string, path: string): boolean {
  const code = codeOnly(source, path);
  return /\bexport\s+(?:async\s+)?function\s+parse\w*\b|\bexport\s+const\s+parse\w*\s*=/
    .test(code);
}

/**
 * Modules that import a fence or scrub helper and export a `parse*` function.
 * `files` maps a module id (a path under `lib/`) to its source.
 */
export function scanEchoConsumers(
  files: Readonly<Record<string, string>>,
): string[] {
  return Object.keys(files).filter((path) =>
    importsEchoHelper(files[path]!, path) &&
    exportsParseFunction(files[path]!, path)
  ).sort();
}

function assertEchoConsumersClassified(
  found: readonly string[],
  table: readonly string[],
  allowlist: readonly EchoAllowlistEntry[],
): void {
  const problems: string[] = [];
  if (found.length === 0) problems.push("Echo scan found nothing");
  const foundSet = new Set(found);
  const tableSet = new Set(table);
  const allowed = new Set(allowlist.map((entry) => entry.module));
  for (
    const [entries, description] of [
      [table, "echo-table row"],
      [allowlist.map((entry) => entry.module), "ECHO_ALLOWLIST entry"],
    ] as const
  ) {
    const seen = new Set<string>();
    for (const name of entries) {
      if (seen.has(name)) problems.push(`Duplicate ${description}: ${name}`);
      seen.add(name);
    }
  }
  for (const name of found) {
    if (!tableSet.has(name) && !allowed.has(name)) {
      problems.push(`Missing echo classification: ${name}`);
    }
    if (tableSet.has(name) && allowed.has(name)) {
      problems.push(`Both a table row and an allowlist entry: ${name}`);
    }
  }
  for (const name of new Set([...table, ...allowed])) {
    if (!foundSet.has(name)) problems.push(`Stale entry: ${name}`);
  }
  for (const entry of allowlist) {
    if (!entry.reason.trim()) {
      problems.push(`Missing allowlist reason: ${entry.module}`);
    }
  }
  assertEquals(problems, [], problems.join("\n"));
}

async function readLibTree(
  dir: URL,
  prefix = "",
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for await (const entry of Deno.readDir(dir)) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory) {
      Object.assign(
        files,
        await readLibTree(new URL(`${entry.name}/`, dir), rel),
      );
    } else if (
      entry.isFile && entry.name.endsWith(".ts") &&
      !entry.name.endsWith("_test.ts")
    ) {
      files[rel] = await Deno.readTextFile(new URL(entry.name, dir));
    }
  }
  return files;
}

Deno.test("echo consumers: every scanned lib module is a table row or an allowlist entry", async () => {
  const found = scanEchoConsumers(
    await readLibTree(new URL("../lib/", import.meta.url)),
  );
  assertEchoConsumersClassified(found, ECHO_TABLE_MODULES, ECHO_ALLOWLIST);
});

Deno.test("echo consumers: a committed multi-line import with parseFoo is flagged", async () => {
  const path = new URL(
    "./fixtures/echo_consumer_multiline_import.txt",
    import.meta.url,
  );
  const source = await Deno.readTextFile(path);
  const importAt = source.indexOf("import {");
  const fromAt = source.indexOf('from "./prompt_delimiter.ts"');
  assert(
    importAt >= 0 && fromAt > importAt &&
      source.slice(importAt, fromAt).includes("\n"),
    "the fixture import must span lines",
  );
  assertEquals(
    scanEchoConsumers({ "echo_consumer_multiline_import.ts": source }),
    ["echo_consumer_multiline_import.ts"],
  );
});

Deno.test("echo consumers: single-line imports count and comments do not", () => {
  const flagged = `
    import { scrubUntrustedText } from "./prompt_delimiter.ts";
    export function parseBar(text: string): string { return text; }
  `;
  assertEquals(scanEchoConsumers({ "flagged.ts": flagged }), ["flagged.ts"]);
  const commented = `
    // import { scrubUntrustedText } from "./prompt_delimiter.ts";
    export function parseBar(text: string): string { return text; }
  `;
  assertEquals(scanEchoConsumers({ "comment.ts": commented }), []);
  const quoted = `
    const example = "import { scrubUntrustedText } from \\"./prompt_delimiter.ts\\";";
    export function parseBar(text: string): string { return text; }
  `;
  assertEquals(scanEchoConsumers({ "quoted.ts": quoted }), []);
  const otherHelper = `
    import { generateBoundaryId } from "./prompt_delimiter.ts";
    export function parseBar(text: string): string { return text; }
  `;
  assertEquals(scanEchoConsumers({ "other.ts": otherHelper }), []);
  const noParser = `
    import { fenceUntrustedIssueText } from "./prompt_delimiter.ts";
    export function renderOnly(): string { return ""; }
  `;
  assertEquals(scanEchoConsumers({ "render.ts": noParser }), []);
  const wrapped = `
    import {
      createPromptDelimiters,
    } from "./prompt_delimiter.ts";
    export async function parseWrapped(text: string): Promise<string> {
      return text;
    }
  `;
  assertEquals(scanEchoConsumers({ "wrapped.ts": wrapped }), ["wrapped.ts"]);
});

Deno.test("echo consumers: an empty scan, a stale entry and a blank reason fail", () => {
  assertThrows(
    () => assertEchoConsumersClassified([], ["closure_met_check.ts"], []),
    Error,
    "Echo scan found nothing",
  );
  assertThrows(
    () => assertEchoConsumersClassified(["live.ts"], ["gone.ts"], []),
    Error,
    "Stale entry: gone.ts",
  );
  assertThrows(
    () =>
      assertEchoConsumersClassified(
        ["live.ts"],
        [],
        [{ module: "retired.ts", reason: "it used to parse a reply" }],
      ),
    Error,
    "Stale entry: retired.ts",
  );
  assertThrows(
    () =>
      assertEchoConsumersClassified(
        ["live.ts"],
        [],
        [{ module: "live.ts", reason: "   " }],
      ),
    Error,
    "Missing allowlist reason: live.ts",
  );
  assertThrows(
    () => assertEchoConsumersClassified(["live.ts"], [], []),
    Error,
    "Missing echo classification: live.ts",
  );
});
