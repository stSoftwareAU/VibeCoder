/**
 * Per-stage outcomes of a quality gate run (Issue #3726).
 *
 * The gate used to record only that it passed on attempt N, so an audit could
 * not tell whether a stage such as `semgrep` PASSED, was SKIPPED (and why) or
 * never ran on a commit. This module turns a gate's checks into a compact,
 * redacted record of each stage's outcome that can be logged and rendered on
 * the run-stats comment.
 *
 * The shape is deliberately gate-agnostic: it is meant to be reused by other
 * gates, such as the pre-push gate (Issue #3770), which is not implemented
 * yet.
 */

import type { CheckResult, CheckStatus } from "./quality_helpers.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { neutraliseHtmlComments } from "./prompt_delimiter.ts";

/** Longest SKIPPED reason kept, in characters, before the trailing ellipsis. */
const MAX_REASON_CHARS = 200;

/** One gate stage's outcome. */
export interface GateStageOutcome {
  readonly name: string;
  readonly status: CheckStatus;
  /** Why the stage was SKIPPED; never set for PASSED or FAILED stages. */
  readonly reason?: string;
}

/** Make free text safe for a single inline code span. */
function inline(text: string): string {
  return neutraliseHtmlComments(
    text.replace(/\s+/g, " ").trim().replaceAll("`", "'"),
  );
}

/** The first non-empty line of already-redacted output, made inline-safe. */
function reasonFrom(output: string): string | undefined {
  const redacted = redactSecrets(output);
  const line = redacted.split(/\r?\n/).find((l) => l.trim() !== "");
  if (line === undefined) return undefined;
  const text = inline(line);
  return text.length > MAX_REASON_CHARS
    ? `${text.slice(0, MAX_REASON_CHARS)}…`
    : text;
}

/**
 * Convert a gate's checks into stage outcomes, keeping their order.
 *
 * Only a SKIPPED stage carries a reason: the first non-empty line of its
 * output, redacted, collapsed to one line and capped.
 */
export function stageOutcomesFrom(
  checks: readonly CheckResult[],
): GateStageOutcome[] {
  return checks.map((check) => {
    const name = inline(check.name);
    if (check.status !== "SKIPPED" || !check.output) {
      return { name, status: check.status };
    }
    const reason = reasonFrom(check.output);
    return reason === undefined
      ? { name, status: check.status }
      : { name, status: check.status, reason };
  });
}

/**
 * Render stage outcomes on one line, grouped passed, skipped, failed (empty
 * groups omitted), or `none recorded` when there are none.
 */
export function formatGateStageOutcomes(
  stages: readonly GateStageOutcome[],
): string {
  const groups: string[] = [];
  const passed = stages.filter((s) => s.status === "PASSED");
  const skipped = stages.filter((s) => s.status === "SKIPPED");
  const failed = stages.filter((s) => s.status === "FAILED");
  if (passed.length > 0) {
    groups.push(`passed: ${passed.map((s) => `\`${s.name}\``).join(", ")}`);
  }
  if (skipped.length > 0) {
    groups.push(
      `skipped: ${
        skipped.map((s) =>
          s.reason
            ? `\`${s.name}\` (\`${s.reason}\`)`
            : `\`${s.name}\` (no reason recorded)`
        ).join(", ")
      }`,
    );
  }
  if (failed.length > 0) {
    groups.push(`failed: ${failed.map((s) => `\`${s.name}\``).join(", ")}`);
  }
  return groups.length > 0 ? groups.join("; ") : "none recorded";
}
