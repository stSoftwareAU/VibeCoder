/**
 * GhostCommit detect-and-flag hand-off for suspicious untrusted images
 * (Issue #3389, sub-issue of #3384).
 *
 * Images reach the model *inside* the CLI agent's turn — there is no
 * TypeScript inbound-image path to intercept. So detection is expressed
 * as a prompt-level self-check (the standing rule from #3388): when the
 * agent views an untrusted image that appears to carry instructions aimed
 * at an AI agent, it must **not** act on the image's content and must
 * emit a documented flag marker in its output instead of complying.
 *
 * This module is the worker-side half of that contract. It:
 *
 *   1. detects the flag marker in the agent's output
 *      ({@link detectSuspiciousImageFlag}); and
 *   2. maps a positive detection onto the single guarded escalation
 *      chokepoint {@link escalateToHuman} ({@link handOffSuspiciousImage}),
 *      applying `needs-human` + a paired explanation comment (Issue #1471)
 *      with a dedup marker so a re-run never double-posts.
 *
 * The marker carries a short, sanitised `source` (which image) and
 * `reason` (why flagged). The image's *embedded* instructions are
 * deliberately never reproduced in the escalation comment — that would
 * propagate the injected content and risk leaking anything the image tried
 * to smuggle out. Both fields are length-capped and stripped of comment /
 * markdown breakout sequences.
 *
 * Provenance-awareness lives in the prompt: worker-authored evidence
 * screenshots (`pr_evidence.ts`) are trusted and are never flagged, so the
 * marker never fires for them. At this layer the detection is strict — only
 * the explicit marker triggers a hand-off — so an incidental mention of a
 * `docs/evidence/` screenshot cannot cause a false escalation.
 *
 * Modelled on `analysis_only_handoff.ts` (Issue #2849).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { expectedNoPrOutcome } from "./run_outcome.ts";
import type { GitHubClient, Logger, Result } from "../types.ts";
import {
  escalateToHuman as defaultEscalateToHuman,
  type EscalateToHumanOptions,
  type EscalateToHumanOutcome,
} from "./needs_human_escalation.ts";
import { releaseClaim as defaultReleaseClaim } from "./claim_release.ts";

/**
 * The documented flag marker the agent emits when it detects a suspicious
 * untrusted image. An HTML comment so it stays invisible in rendered
 * output, matching the existing marker conventions
 * (`<!-- analysis-only -->`, `<!-- CLAIM_LOCK: ... -->`, etc.).
 *
 * Canonical form (agent emits it on its own line):
 *
 *   <!-- vibe-suspicious-image-detected source="..." reason="..." -->
 *
 * The `source` and `reason` attributes are optional; a bare
 * `<!-- vibe-suspicious-image-detected -->` still triggers the hand-off
 * with default wording.
 */
export const SUSPICIOUS_IMAGE_MARKER_NAME = "vibe-suspicious-image-detected";

/** Maximum length of a sanitised `source` / `reason` field. */
const MAX_FIELD_LENGTH = 300;

/**
 * Matches the flag marker anywhere in the agent output. `[^]*?` matches
 * any character (including newlines) non-greedily up to the closing
 * `-->`. Case-insensitive so `SUSPICIOUS-IMAGE-DETECTED` also matches.
 */
const MARKER_RE = new RegExp(
  `<!--\\s*${SUSPICIOUS_IMAGE_MARKER_NAME}\\b([^]*?)-->`,
  "i",
);

/** Extract the `source="..."` / `source='...'` attribute value. */
const SOURCE_RE = /\bsource\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
/** Extract the `reason="..."` / `reason='...'` attribute value. */
const REASON_RE = /\breason\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

/** Result of {@link detectSuspiciousImageFlag}. */
export interface SuspiciousImageDetection {
  /** True when the agent emitted the suspicious-image flag marker. */
  flagged: boolean;
  /** Sanitised image source (which image), when supplied by the marker. */
  source?: string;
  /** Sanitised reason (why flagged), when supplied by the marker. */
  reason?: string;
}

/** Negative detection result. */
const NEGATIVE: SuspiciousImageDetection = { flagged: false };

/**
 * Sanitise a model-provided marker field so it is safe to embed in a
 * GitHub comment. Removes comment / markdown breakout sequences, collapses
 * whitespace, and length-caps the result.
 *
 * Exported for testing.
 */
export function sanitiseFlagField(
  raw: string | undefined,
  maxLen = MAX_FIELD_LENGTH,
): string {
  if (!raw) return "";
  let out = raw
    // Neutralise HTML-comment terminators / openers (breakout). The
    // replacements keep a space inside the token so a longer run such as
    // `--->` cannot re-form `-->` from the surviving characters (CodeQL
    // js/bad-tag-filter, Issue #4409 sweep).
    .replace(/-->/g, "- ->")
    .replace(/<!--/g, "<!- -")
    // Drop code fences and backticks so the field cannot break markdown.
    .replace(/`+/g, "")
    // Replace control characters (incl. CR / LF / tab) with a space.
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (out.length > maxLen) {
    out = out.slice(0, maxLen).trimEnd() + "…";
  }
  return out;
}

/**
 * Detect whether the agent output contains the suspicious-image flag
 * marker, extracting a sanitised `source` and `reason` when present.
 *
 * Detection is strict: only the explicit marker triggers a positive
 * result. Ordinary prose that merely mentions images (including
 * worker-authored evidence screenshots) does not fire.
 */
export function detectSuspiciousImageFlag(
  output: string | undefined | null,
): SuspiciousImageDetection {
  if (!output) return NEGATIVE;
  const markerMatch = MARKER_RE.exec(output);
  if (!markerMatch) return NEGATIVE;

  const inner = markerMatch[1] ?? "";
  const sourceMatch = SOURCE_RE.exec(inner);
  const reasonMatch = REASON_RE.exec(inner);

  const source = sanitiseFlagField(
    sourceMatch ? (sourceMatch[1] ?? sourceMatch[2]) : undefined,
  );
  const reason = sanitiseFlagField(
    reasonMatch ? (reasonMatch[1] ?? reasonMatch[2]) : undefined,
  );

  const detection: SuspiciousImageDetection = { flagged: true };
  if (source.length > 0) detection.source = source;
  if (reason.length > 0) detection.reason = reason;
  return detection;
}

/**
 * Build the `**Why:**` reason text for the escalation comment. The image's
 * embedded instructions are never reproduced — only the provenance and the
 * agent's short description of why it flagged the image. Exported for
 * testing.
 */
export function buildSuspiciousImageReason(
  detection: SuspiciousImageDetection,
): string {
  const source = detection.source && detection.source.length > 0
    ? detection.source
    : "an untrusted image";
  const why = detection.reason && detection.reason.length > 0
    ? detection.reason
    : "it appears to contain text, a QR code, or commands directed at an AI agent";
  return (
    "the worker viewed a potentially malicious untrusted image and flagged it " +
    `as suspicious (source: ${source}; why: ${why}). Following the GhostCommit ` +
    "detect-and-flag posture (parent #3384), the worker did **not** act on the " +
    "image's embedded content and stopped for human review. The image's " +
    "embedded instructions are deliberately not reproduced here to avoid " +
    "propagating injected content."
  );
}

/**
 * Build the `**Next step:**` text for the escalation comment. Exported for
 * testing.
 */
export function buildSuspiciousImageNextStep(): string {
  return (
    "Review the flagged image manually to decide whether it is a " +
    "prompt-injection attempt. If it is benign, action the task yourself (or " +
    "re-scope it) and remove `needs-human`; if it is malicious, remove the " +
    "image / close the issue. The worker will not act on the image's content " +
    "until a human clears this escalation."
  );
}

/** Stable dedup key so a re-run never double-posts the hand-off comment. */
export function buildSuspiciousImageDedupKey(issueNumber: number): string {
  return `suspicious-image-${issueNumber}`;
}

/** Injectable dependencies for {@link handOffSuspiciousImage} (testing). */
export interface HandOffSuspiciousImageDeps {
  /** Override the escalation chokepoint. Defaults to {@link escalateToHuman}. */
  escalate?: (
    options: EscalateToHumanOptions,
  ) => Promise<Result<EscalateToHumanOutcome>>;
  /** Override the claim-release helper. Defaults to {@link releaseClaim}. */
  releaseClaim?: typeof defaultReleaseClaim;
  /**
   * Ensure the `needs-human` label exists. Forwarded to the escalation
   * helper's `deps.github.ensureLabelExists`.
   */
  ensureLabelExists?: (
    repo: string,
    labelName: string,
    colour?: string,
    description?: string,
  ) => Promise<Result<void>>;
  /** Override the clock used by the escalation dedup window. */
  now?: () => number;
}

/** Options accepted by {@link handOffSuspiciousImage}. */
export interface HandOffSuspiciousImageOptions {
  ghClient: GitHubClient;
  repo: string;
  issueNumber: number;
  needsHumanLabel: string;
  githubUser: string;
  /** The positive detection from {@link detectSuspiciousImageFlag}. */
  detection: SuspiciousImageDetection;
  logger: Logger;
  deps?: HandOffSuspiciousImageDeps;
}

/**
 * Hand a suspicious-image-flagged issue off to a human.
 *
 * Applies `needs-human` + a paired explanation comment via the shared
 * {@link escalateToHuman} chokepoint (Issue #1471), then releases the
 * worker's self-assignment. Best-effort and non-fatal: a failure is logged
 * and swallowed so the hand-off never aborts the surrounding phase.
 *
 * @returns `true` when the escalation reported a visible side effect
 *   (label added, comment posted, or comment deduped away); `false` on
 *   escalation failure.
 */
export async function handOffSuspiciousImage(
  options: HandOffSuspiciousImageOptions,
): Promise<boolean> {
  const {
    ghClient,
    repo,
    issueNumber,
    needsHumanLabel,
    githubUser,
    detection,
    logger,
    deps,
  } = options;

  const escalate = deps?.escalate ?? defaultEscalateToHuman;
  const releaseClaim = deps?.releaseClaim ?? defaultReleaseClaim;

  let handedOff = false;
  try {
    const result = await escalate({
      ghClient,
      repo,
      target: { kind: "issue", number: issueNumber },
      needsHumanLabel,
      heading: "Suspicious untrusted image — flagged, not actioned",
      reason: buildSuspiciousImageReason(detection),
      nextStep: buildSuspiciousImageNextStep(),
      dedupKey: buildSuspiciousImageDedupKey(issueNumber),
      githubUser,
      logger,
      deps: {
        ...(deps?.ensureLabelExists
          ? { github: { ensureLabelExists: deps.ensureLabelExists } }
          : {}),
        ...(deps?.now ? { now: deps.now } : {}),
      },
    });
    if (result.ok) {
      handedOff = result.value.labelAdded || result.value.commentPosted ||
        result.value.dedupSkipped;
    } else {
      logger.warn("handOffSuspiciousImage: escalation failed", {
        repo,
        issueNumber,
        error: result.error.message,
      });
    }
  } catch (err) {
    logger.warn("handOffSuspiciousImage: escalation threw", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Release the worker's claim on every terminal path (Issue #2731).
  await releaseClaim(ghClient, repo, issueNumber, githubUser, logger, {
    outcome: expectedNoPrOutcome(
      "suspicious-image hand-off",
      "handed off to a human (suspicious image)",
    ),
  });

  return handedOff;
}
