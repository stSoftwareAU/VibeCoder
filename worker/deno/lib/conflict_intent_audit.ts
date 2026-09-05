/**
 * The audit surface for intent-aware conflict resolution (Issue #1114,
 * parent #1076).
 *
 * An intent override is a judgement call, so the PR comment — not the diff —
 * is what makes it reviewable afterwards. Two records do that:
 *
 * - **Issues consulted**, recorded on the attempt itself, before the agent
 *   runs. It names the PR-side issue, the base-side issues keyed by conflicted
 *   path, and — explicitly — the paths for which no issue was discoverable.
 *   Because it is written on the attempt, it survives a resolution that then
 *   fails: a reader can tell "the resolver looked and disagreed" from "the
 *   resolver never looked", which is exactly the ambiguity that made #1076
 *   expensive to diagnose.
 * - **Intent overrides**, recorded on the resolution. The agent declares each
 *   one in `.pr_response_message` in a fixed shape; this module parses that
 *   shape, renders it file-by-file with both issue numbers, and flags loudly
 *   any claim it cannot corroborate against the issues that were actually
 *   consulted.
 *
 * Nothing here enforces anything. The mechanical guards — unmerged paths,
 * leftover conflict markers, base-is-an-ancestor — remain the enforcement, and
 * an intent-justified resolution is not exempt from any of them.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { ConflictIssueContext } from "./conflict_issue_context.ts";
import {
  assessIntentEligibility,
  describeBaseUnresolved,
  describePrUnresolved,
  normaliseConflictPath,
  sanitiseIssueText,
} from "./conflict_intent_context.ts";

/** The shape the agent must use to declare an override. */
export const INTENT_OVERRIDE_SYNTAX =
  "Intent override: <path> — kept #<issue>, superseded #<issue> — <one line>";

/** A declared override, parsed from `.pr_response_message`. */
export interface IntentOverride {
  /** The conflicted file the override applies to. */
  path: string;
  /** The issue whose intent was kept. */
  kept: number;
  /** The issue that intent supersedes. */
  superseded: number;
  /** The agent's one-line justification. */
  note: string;
}

/** Overrides the agent declared, and claims that were not well-formed. */
export interface IntentOverrideReport {
  overrides: IntentOverride[];
  /** Lines that announced an override but did not carry the whole shape. */
  malformed: string[];
}

/** A line that announces an override, however well it is formed. */
const OVERRIDE_LINE = /^\s*(?:[-*]\s*)?intent override\s*:/i;

/**
 * The whole shape: path, both issue numbers, and a justification.
 *
 * Either an em dash or a hyphen separates the three parts — models produce
 * both — but every part is required. A claim missing one is reported as
 * malformed rather than parsed generously: an override nobody can audit is
 * the failure this record exists to prevent.
 */
const OVERRIDE_SHAPE =
  /^\s*(?:[-*]\s*)?intent override\s*:\s*`?([^`\n]+?)`?\s*(?:—|--|-)\s*kept\s+#(\d+)\s*,\s*superseded\s+#(\d+)\s*(?:—|--|-)\s*(\S.*)$/i;

/**
 * Parse the intent overrides the agent declared in `.pr_response_message`.
 *
 * @param detail - The agent's reply, or `undefined` when it wrote none
 * @returns Well-formed overrides, plus every malformed claim, stated
 */
export function parseIntentOverrides(
  detail: string | undefined | null,
): IntentOverrideReport {
  const overrides: IntentOverride[] = [];
  const malformed: string[] = [];
  if (!detail) return { overrides, malformed };

  for (const line of detail.split("\n")) {
    if (!OVERRIDE_LINE.test(line)) continue;
    const match = OVERRIDE_SHAPE.exec(line);
    if (!match) {
      malformed.push(sanitiseIssueText(line.trim()));
      continue;
    }
    overrides.push({
      path: sanitiseIssueText((match[1] ?? "").trim()),
      kept: Number(match[2]),
      superseded: Number(match[3]),
      note: sanitiseIssueText((match[4] ?? "").trim()),
    });
  }
  return { overrides, malformed };
}

/**
 * The "issues consulted" record for one attempt.
 *
 * Always returns lines: "no originating issues were found" is a result, and
 * printing nothing would leave a reader unable to tell it from an attempt that
 * never looked.
 */
export function buildConsultedIssuesSection(
  context: ConflictIssueContext | null | undefined,
): string[] {
  const lines = ["🧭 **Issues consulted**", ""];

  if (!context) {
    lines.push(
      "No originating issues were found for either side of this conflict — " +
        "no issue context was available for this attempt. The " +
        "both-sides-survive contract applies unchanged: the resolver may not " +
        "let one side win on intent.",
    );
    return lines;
  }

  lines.push(
    context.prSide.resolved
      ? `- **PR side** — #${context.prSide.issue.number}: ${
        sanitiseIssueText(context.prSide.issue.title)
      } (via ${context.prSide.signal})`
      : `- **PR side** — none found: ${
        describePrUnresolved(context.prSide.reason)
      }.`,
  );

  if (context.baseSide.length === 0) {
    lines.push("- **Base side** — no conflicted path was submitted.");
  } else {
    lines.push("- **Base side**, by conflicted path:");
    for (const entry of context.baseSide) {
      const path = `\`${sanitiseIssueText(entry.path)}\``;
      if (entry.unresolved !== null) {
        lines.push(
          `  - ${path} — none found: ${
            describeBaseUnresolved(entry.unresolved)
          }.`,
        );
        continue;
      }
      const issues = entry.issues.map((issue) =>
        `#${issue.number} (${sanitiseIssueText(issue.title)})`
      ).join(", ");
      lines.push(`  - ${path} — ${issues}${entry.partial ? " (partial)" : ""}`);
    }
  }

  const assessments = assessIntentEligibility(context);
  const eligible = assessments.filter((a) => a.eligible).map((a) => a.path);
  const ineligible = assessments.filter((a) => !a.eligible).map((a) => a.path);

  lines.push(
    "",
    eligible.length === 0
      ? "Both sides' issues are known for **no** conflicted path, so no " +
        "intent override is permitted on this attempt — both sides survive, " +
        "or the resolution stops."
      : `Both sides' issues are known for ${
        eligible.map((p) => `\`${sanitiseIssueText(p)}\``).join(", ")
      }. Only there may an issue that explicitly supersedes the other settle the conflict.`,
  );
  if (ineligible.length > 0) {
    lines.push(
      `No originating issue was discoverable for both sides of ${
        ineligible.map((p) => `\`${sanitiseIssueText(p)}\``).join(", ")
      }, so the unchanged contract applies there.`,
    );
  }

  if (context.warnings.length > 0) {
    lines.push(
      "",
      `⚠️ Gathering the context was incomplete: ${
        context.warnings.map((w) => sanitiseIssueText(w)).join("; ")
      }`,
    );
  }

  return lines;
}

/** The paths for which both sides' originating issues were actually known. */
function eligiblePathSet(
  context: ConflictIssueContext | null | undefined,
): Set<string> {
  return new Set(
    assessIntentEligibility(context)
      .filter((assessment) => assessment.eligible)
      .map((assessment) => normaliseConflictPath(assessment.path)),
  );
}

/**
 * Overrides claimed where the evidence an override requires was absent.
 *
 * This is the deterministic half of the carve-out, and the worker refuses a
 * resolution that trips it: a well-formed override on a path where both sides'
 * originating issues were *not* known is a side-pick with a justification
 * attached, which is precisely the silent-work-destruction shape the
 * never-side-pick contract exists to prevent. Malformed claims are deliberately
 * not included — a line the parser could not read is reported on the PR rather
 * than treated as a confession.
 */
export function findUncorroboratedOverrides(
  report: IntentOverrideReport,
  context: ConflictIssueContext | null | undefined,
): IntentOverride[] {
  const eligible = eligiblePathSet(context);
  return report.overrides.filter((override) =>
    !eligible.has(normaliseConflictPath(override.path))
  );
}

/**
 * The intent-override record for a resolution that landed.
 *
 * Empty when the agent declared no override, so a conflict resolved the
 * ordinary way produces exactly the comment it produced before this change.
 *
 * A claim on a path where both sides' issues were **not** known is rendered as
 * a warning rather than dropped. {@link findUncorroboratedOverrides} means the
 * processor has already refused such a resolution, so this is defence in depth
 * — if one ever reaches a comment, it says so rather than reading as an
 * evidenced pick.
 */
export function buildIntentOverrideSection(
  report: IntentOverrideReport,
  context: ConflictIssueContext | null | undefined,
): string[] {
  if (report.overrides.length === 0 && report.malformed.length === 0) return [];

  const eligiblePaths = eligiblePathSet(context);

  const lines = [
    "",
    "**Settled by issue intent — one side superseded the other:**",
    "",
  ];
  for (const override of report.overrides) {
    lines.push(
      `- \`${override.path}\` — kept #${override.kept}, superseded #${override.superseded}: ${override.note}`,
    );
    if (!eligiblePaths.has(normaliseConflictPath(override.path))) {
      lines.push(
        `  - ⚠️ both sides' originating issues were **not** known for this ` +
          "path, so this justification is uncorroborated — review the file " +
          "in the diff.",
      );
    }
  }
  for (const claim of report.malformed) {
    lines.push(
      `- ⚠️ an override was claimed but not stated in the required shape ` +
        `(\`${INTENT_OVERRIDE_SYNTAX}\`), so it could not be recorded: ` +
        `${claim}`,
    );
  }
  lines.push(
    "",
    "An override is permitted only where both sides' originating issues are " +
      "known and one explicitly supersedes the other. Audit the picks above " +
      "against those issues rather than in the diff.",
  );
  return lines;
}
