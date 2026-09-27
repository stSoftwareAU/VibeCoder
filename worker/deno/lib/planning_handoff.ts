/**
 * Worker `work-on` → `planning` hand-off (Issue #2688).
 *
 * When an implementation run decides its `work-on` issue genuinely needs
 * decomposing into several independent PRs, it emits
 * `<!-- vibe-needs-planning reason="…" -->`. The worker then applies
 * `planning` itself — through the audited
 * {@link assertWorkerCanHandOffToPlanning} guard — instead of stopping at
 * `needs-human`. Label security honours that label only while the trusted
 * `work-on` add still anchors it (`planning_handoff_trust.ts`).
 *
 * ```mermaid
 * flowchart TD
 *   R["Run emits vibe-needs-planning"] --> P{"Prior hand-off<br/>marker on the issue?"}
 *   P -->|yes| H["needs-human (loop guard)"]
 *   P -->|no| G{"Guard allows planning?"}
 *   G -->|no| H
 *   G -->|yes| L{"addLabel planning ok?"}
 *   L -->|no| H
 *   L -->|yes| C["Comment + marker, release claim"]
 * ```
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { expectedNoPrOutcome, type RunOutcome } from "./run_outcome.ts";
import { releaseClaim as defaultReleaseClaim } from "./claim_release.ts";
import { assertWorkerCanHandOffToPlanning } from "./worker_label_guard.ts";
import { PLANNING_HANDOFF_LABEL } from "./planning_handoff_trust.ts";
import { redactSecrets } from "./secret_redaction.ts";
import { neutraliseAgentMarkers } from "./agent_marker_neutralisation.ts";
import type { AuditMutation } from "./audit_entry.ts";
import type { GitHubClient, Logger, Result } from "../types.ts";

/** Marker the run emits to request the hand-off. */
export const PLANNING_HANDOFF_REQUEST_MARKER_NAME = "vibe-needs-planning";

/** Marker the worker leaves on the issue once it has handed off. */
export const PLANNING_HANDOFF_MARKER_NAME = "vibe-planning-handoff";

/** Longest reason carried into the public comment. */
export const MAX_PLANNING_REASON_LENGTH = 500;

const REQUEST_RE = new RegExp(
  `<!--\\s*${PLANNING_HANDOFF_REQUEST_MARKER_NAME}(?![A-Za-z0-9_:-])([^]*?)-->`,
  "i",
);
const REASON_RE = /\breason\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** Parsed hand-off request. */
export interface PlanningHandoffRequest {
  reason: string;
}

/**
 * Detect a `vibe-needs-planning` request in the run output. A marker without
 * a non-blank `reason` is ignored, so the run falls through to `needs-human`.
 */
export function detectPlanningHandoff(
  output: string,
): PlanningHandoffRequest | undefined {
  const marker = REQUEST_RE.exec(output);
  if (!marker) return undefined;
  const attr = REASON_RE.exec(marker[1] ?? "");
  const reason = (attr?.[1] ?? attr?.[2] ?? "").trim();
  if (!reason) return undefined;
  return { reason: reason.slice(0, MAX_PLANNING_REASON_LENGTH) };
}

/** The marker the worker's hand-off comment carries. */
export function buildPlanningHandoffMarker(): string {
  return `<!-- ${PLANNING_HANDOFF_MARKER_NAME} -->`;
}

/** True when the worker has already handed this issue to planning once. */
export function hasPriorPlanningHandoff(comments: string): boolean {
  if (!comments) return false;
  return comments.toLowerCase().includes(buildPlanningHandoffMarker());
}

/**
 * Build the public hand-off comment. Agent-derived text is marker-neutralised
 * so it cannot forge a fleet marker (including this hand-off's own) in a
 * worker-authored comment.
 */
export function buildPlanningHandoffComment(
  rawReason: string,
  rawOutputSnippet: string,
): string {
  const reason = neutraliseAgentMarkers(rawReason).text;
  const outputSnippet = neutraliseAgentMarkers(rawOutputSnippet).text;
  const quoted = reason.split("\n").map((l) => `> ${l}`).join("\n");
  const details = outputSnippet
    ? `<details>\n<summary>Full output</summary>\n\n\`\`\`\n${outputSnippet}\n\`\`\`\n\n</details>\n\n`
    : "";
  return `## Handed off to planning\n\n` +
    `This issue is too large for one PR, so the worker has added ` +
    `\`planning\` to break it into sub-issues. \`work-on\` stays on the ` +
    `issue as the trusted anchor for the hand-off (Issue #2688).\n\n` +
    `**Reason given by the run:**\n\n${quoted}\n\n` +
    details +
    buildPlanningHandoffMarker();
}

/** Injectable seams for tests. */
export interface PlanningHandoffDeps {
  releaseClaim?: typeof defaultReleaseClaim;
  ensureLabelExists?: (
    repo: string,
    labelName: string,
    colour?: string,
    description?: string,
  ) => Promise<Result<void>>;
  labelGuardLogFn?: (line: string) => void;
  /** Audit-journal writer passed to the guard. */
  recordAudit?: (mutation: AuditMutation) => Promise<Result<unknown>>;
  /** Seam so the refusal branch is testable. */
  assertHandoffAllowed?: typeof assertWorkerCanHandOffToPlanning;
}

export interface PlanningHandoffOptions {
  ghClient: GitHubClient;
  repo: string;
  issueNumber: number;
  githubUser: string;
  reason: string;
  outputSnippet: string;
  logger: Logger;
  deps?: PlanningHandoffDeps;
}

/** `applied: false` means nothing was released — the caller must fall back. */
export interface PlanningHandoffResult {
  applied: boolean;
  outcome?: RunOutcome;
}

/**
 * Apply `planning`, post the hand-off comment and release the claim. A
 * refused guard or a failed label add is logged and returns
 * `applied: false` without releasing, so the caller escalates instead.
 */
export async function handOffToPlanning(
  options: PlanningHandoffOptions,
): Promise<PlanningHandoffResult> {
  const { ghClient, repo, issueNumber, githubUser, logger, deps } = options;
  const target = `${repo}#${issueNumber}`;
  const assertAllowed = deps?.assertHandoffAllowed ??
    assertWorkerCanHandOffToPlanning;

  const guard = assertAllowed(PLANNING_HANDOFF_LABEL, {
    caller: `handOffToPlanning(${target})`,
    target,
    logFn: deps?.labelGuardLogFn,
    record: deps?.recordAudit,
  });
  if (!guard.ok) {
    logger.warn(
      `Planning hand-off refused for ${target}: ${guard.error.message}`,
    );
    return { applied: false };
  }

  try {
    const ensured = await deps?.ensureLabelExists?.(
      repo,
      PLANNING_HANDOFF_LABEL,
      "5319e7",
      "Break this issue into sub-issues",
    );
    if (ensured && !ensured.ok) throw ensured.error;
    await ghClient.addLabel(repo, issueNumber, PLANNING_HANDOFF_LABEL);
  } catch (error) {
    logger.warn(
      `Failed to add '${PLANNING_HANDOFF_LABEL}' to ${target}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { applied: false };
  }

  // The label is on; a failed comment loses only the explanation.
  try {
    await ghClient.postComment(
      repo,
      issueNumber,
      buildPlanningHandoffComment(
        redactSecrets(options.reason),
        options.outputSnippet,
      ),
    );
  } catch (error) {
    logger.warn(
      `Failed to post planning hand-off comment on ${target}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const outcome = expectedNoPrOutcome(
    "handle_no_changes",
    "handed off to planning",
  );
  const releaseClaim = deps?.releaseClaim ?? defaultReleaseClaim;
  await releaseClaim(ghClient, repo, issueNumber, githubUser, logger, {
    outcome,
  });
  return { applied: true, outcome };
}
