/**
 * Quality gate check: a truncation may not run **inside** a redaction call
 * (Issue #1257).
 *
 * `SECURITY.md` requires the opposite order: a sink that trims output to a
 * size limit runs `redactSecrets()` first, because cutting first splits a
 * credential — most damagingly a PEM block, whose `END` marker falls past the
 * cut — leaving a fragment that no signature rule matches on the later pass.
 *
 * The rule was held by prose and by the `RedactedText` brand
 * (`redacted_text.ts`), and both leave the same gap: the brand stops a raw
 * slice reaching a *branded field*, but nothing stopped a call site writing
 * `redactSecrets(truncateLogTail(log, maxBytes))` — the inversion two modules
 * had even documented in their own comments. This check closes that gap
 * statically, in the shape of the sibling `gh`/`git` spawn chokepoint checks
 * (Issues #3703, #1214): a whole-codebase invariant belongs in the quality
 * gate, not the unit-test runner.
 *
 * What it flags: a call to a redaction entry point whose **argument
 * expression** itself truncates — `.slice(`, `.substring(`, `.substr(` or
 * `truncateLogTail(`. The argument text is extracted by matching parentheses
 * rather than by a regex, so no pattern can backtrack over attacker-length
 * input and the nesting is read exactly.
 *
 * What it does not flag: the compliant order, `redactSecrets(text).slice(-500)`
 * — the cut is outside the call — and any truncation with no redaction around
 * it, which this check cannot see. Redacting first is enforceable statically;
 * "this text reaches a sink" is not.
 *
 * The scanning functions are pure and exported so the check is tested
 * behaviourally against literal inputs.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import {
  type DirectSpawnScanResult,
  type DirectSpawnViolation,
  stripLineAndBlockComments,
  walkTsFiles,
} from "./spawn_chokepoint_scan.ts";

/** A single redact-after-truncate inversion. */
export type RedactOrderViolation = DirectSpawnViolation;

/** Result of scanning one or more directories. */
export type RedactOrderCheckResult = DirectSpawnScanResult;

/**
 * Calls that promise "this text has been redacted in full".
 *
 * The branded constructors are included deliberately: `redactedTail(
 * raw.slice(-500), 500)` type-checks, and the module's own documentation names
 * that as the hole the type system cannot close.
 */
export const REDACTION_ENTRY_POINTS: readonly string[] = [
  "redactSecrets",
  "redactedTail",
  "redactedHead",
  "redactedHeadTail",
  "redactedLineTail",
  "redactedLogTail",
];

/** Truncating calls that must never appear inside a redaction argument. */
export const TRUNCATION_CALLS: readonly string[] = [
  ".slice(",
  ".substring(",
  ".substr(",
  "truncateLogTail(",
];

/**
 * Repo-relative paths whose match is a documented false positive.
 *
 * `redacted_text.ts` is the module that *implements* redact-before-truncate:
 * its constructors slice the already-redacted result inside their own bodies.
 */
export const REDACT_ORDER_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // Implements redact-before-truncate: its constructors slice the
  // already-redacted result inside their own bodies.
  "worker/deno/lib/redacted_text.ts",
  // `redactSecrets(arg.substring("--body=".length))` strips a known literal
  // flag prefix — not a size cap — and redacts the whole remaining value.
  "worker/deno/lib/gh_body_redaction.ts",
]);

/** Is `source[index]` the start of an identifier-delimited `name(`? */
function callStartsAt(source: string, index: number, name: string): boolean {
  if (!source.startsWith(name, index)) return false;
  const before = index === 0 ? "" : source[index - 1] ?? "";
  if (/[A-Za-z0-9_$.]/.test(before)) return false;
  return source[index + name.length] === "(";
}

/**
 * Extract the text between the parentheses of a call whose `(` sits at
 * `openIndex`, tracking nesting, string literals and template literals.
 *
 * String and template contents are blanked in the returned text: a call that
 * merely *names* `.slice(` inside a message is not truncating anything, and
 * flagging it would make the check impossible to satisfy in a module that
 * documents the rule.
 *
 * @returns The argument text with literals blanked, or `null` when the
 *   parentheses never close.
 */
function extractCallArguments(
  source: string,
  openIndex: number,
): string | null {
  let depth = 0;
  let quote: string | null = null;
  const kept: string[] = [];
  for (let i = openIndex; i < source.length; i++) {
    const char = source[i] ?? "";
    if (quote) {
      kept.push(" ");
      if (char === "\\") {
        kept.push(" ");
        i++;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      kept.push(" ");
      continue;
    }
    kept.push(char);
    if (char === "(") depth++;
    else if (char === ")") {
      depth--;
      if (depth === 0) return kept.slice(1, -1).join("");
    }
  }
  return null;
}

/**
 * Scan a file's content for a truncation nested inside a redaction call.
 *
 * Comments are stripped first (line numbers preserved) so prose describing the
 * forbidden shape — including this module's own header — is not a violation.
 *
 * @param content - The raw file text.
 * @param repoRelPath - Repo-relative path, recorded on each violation.
 * @returns One violation per offending call.
 */
export function scanContentForRedactInversion(
  content: string,
  repoRelPath: string,
): RedactOrderViolation[] {
  if (REDACT_ORDER_ALLOWLIST.has(repoRelPath)) return [];

  const code = stripLineAndBlockComments(content);
  const rawLines = content.split("\n");
  const violations: RedactOrderViolation[] = [];

  for (let i = 0; i < code.length; i++) {
    const name = REDACTION_ENTRY_POINTS.find((fn) => callStartsAt(code, i, fn));
    if (!name) continue;
    const args = extractCallArguments(code, i + name.length);
    i += name.length;
    if (args === null) continue;
    if (!TRUNCATION_CALLS.some((call) => args.includes(call))) continue;
    const line = code.slice(0, i).split("\n").length;
    violations.push({
      file: repoRelPath,
      line,
      text: (rawLines[line - 1] ?? "").trim(),
    });
  }

  return violations;
}

/**
 * Scan the given repo-relative directories for redact-after-truncate
 * inversions.
 *
 * @param repoRoot - Absolute repo root (no trailing slash required).
 * @param relDirs - Repo-relative directories to scan.
 * @returns Aggregated violations and the number of files scanned.
 */
export async function scanDirectoriesForRedactInversion(
  repoRoot: string,
  relDirs: readonly string[],
): Promise<RedactOrderCheckResult> {
  const root = repoRoot.replace(/\/$/, "");
  const violations: RedactOrderViolation[] = [];
  let filesScanned = 0;

  for (const relDir of relDirs) {
    for await (const absFile of walkTsFiles(`${root}/${relDir}`, true)) {
      const repoRel = absFile.slice(root.length + 1);
      if (REDACT_ORDER_ALLOWLIST.has(repoRel)) continue;
      filesScanned++;
      violations.push(
        ...scanContentForRedactInversion(
          await Deno.readTextFile(absFile),
          repoRel,
        ),
      );
    }
  }

  return { violations, filesScanned };
}
