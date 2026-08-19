/**
 * Pickup-time content-integrity re-verification (Issue #3647).
 *
 * The scan-time control (Issue #1341) verifies a copy of the issue body it
 * fetches itself, then discards it — the body that actually reaches the Claude
 * prompt is an independent, later fetch that was never re-checked. Tens of
 * seconds to minutes of fleet-wide scanning separate the two, so an author who
 * edits the body inside that window has the agent implement a specification no
 * trusted author ever approved (CWE-367 TOCTOU).
 *
 * This module closes the window by re-verifying the exact title and body that
 * will be interpolated into the prompt, immediately before the prompt is built.
 * The snapshot is already on disk and the content is already in hand, so the
 * check costs one hash and no network call on the common path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { WorkerConfig } from "../types.ts";
import type { ContentApprovalDeps } from "./content_approval_tracker.ts";
import type { TimelineCache } from "./timeline_cache.ts";
import { resolveContentIntegrity } from "./work_on_content_integrity.ts";
import { runGhCommand } from "./github.ts";

/** The issue content about to be handed to the prompt builder. */
export interface PickupContentIntegrityInput {
  repo: string;
  issueNumber: number;
  /** Exact title that will reach the model. */
  issueTitle: string;
  /** Exact body that will reach the model. */
  issueBody: string;
  /** Current labels — used to name the approval label in the escalation. */
  issueLabels: string[];
  /** Issue author login, if known. */
  issueAuthor?: string;
  config: WorkerConfig;
}

/** Injectable seams. Defaults wire the production implementations. */
export interface PickupContentIntegrityDeps {
  ghFn?: (args: string[]) => Promise<string>;
  contentDeps?: ContentApprovalDeps;
  timelineCache?: TimelineCache;
}

/**
 * Outcome of the pickup check.
 *
 * `blocked: true` means the content changed after approval and the untrusted
 * modification has already been escalated (approval label removed,
 * `needs-human` applied, comment posted) — the caller must not build a prompt.
 */
export type PickupContentIntegrityOutcome =
  | { blocked: false }
  | { blocked: true; reason: string };

/**
 * Pick the approval label that gated this issue.
 *
 * The snapshot is keyed by repo and issue number only, so the label is needed
 * purely to name (and strip) the right approval in the escalation. Priority
 * labels are checked first because they outrank `work-on` at pickup.
 */
export function resolveApprovalLabel(
  issueLabels: string[],
  config: WorkerConfig,
): string {
  const present = new Set(issueLabels);
  const candidates = [
    ...(config.issueLabels ?? []),
    config.workOnLabel,
    config.lowPriorityLabel,
  ];
  return candidates.find((label) => label && present.has(label)) ??
    config.workOnLabel;
}

/**
 * Re-verify issue content at the point of consumption (Issue #3647).
 *
 * Applies the same semantics as the scan-time collectors via the shared
 * `resolveContentIntegrity`: unchanged content proceeds, a trusted
 * re-approval or trusted author refreshes the snapshot and proceeds, and an
 * untrusted modification blocks and escalates. A missing snapshot blocks
 * without capturing one (Issue #3876) — nothing was approved, so there is
 * neither anything to verify against nor anything that may be blessed here.
 */
export async function verifyPickupContentIntegrity(
  input: PickupContentIntegrityInput,
  deps: PickupContentIntegrityDeps = {},
): Promise<PickupContentIntegrityOutcome> {
  const verdict = await resolveContentIntegrity({
    repo: input.repo,
    issueNumber: input.issueNumber,
    issueAuthor: input.issueAuthor ?? "",
    currentTitle: input.issueTitle,
    currentBody: input.issueBody,
    config: input.config,
    ghFn: deps.ghFn ?? runGhCommand,
    approvalLabel: resolveApprovalLabel(input.issueLabels, input.config),
    captureWhenMissing: false,
    contentDeps: deps.contentDeps,
    timelineCache: deps.timelineCache,
  });

  if (verdict.verdict === "blocked") {
    // Issue #3876: name the actual fault. Every block used to be reported as
    // a content modification, which hid the missing-baseline case the gate
    // now refuses to pass — the two need to be distinguishable in the logs.
    const marker = verdict.reason === "content-modified-after-approval"
      ? "PICKUP_CONTENT_MODIFIED"
      : "PICKUP_CONTENT_UNVERIFIED";
    console.error(
      `[SECURITY] [${marker}] ${input.repo}#${input.issueNumber} failed ` +
        `pickup-time content verification (${verdict.reason}) — BLOCKED`,
    );
    return { blocked: true, reason: verdict.reason };
  }

  return { blocked: false };
}
