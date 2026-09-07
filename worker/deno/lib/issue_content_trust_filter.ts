/**
 * Trust-aware filtering for the issue body + title (Issue #3312).
 *
 * Author-trust filtering historically classified *comments* only; the issue
 * body and title — the primary prompt-injection surface (the GitLost
 * body-borne attack) — were merely audit-logged with a bare `console.warn`
 * and otherwise passed through unchanged.
 *
 * This module gives the body/title the same treatment untrusted comments
 * receive, reusing the existing machinery rather than forking a second
 * detector:
 *
 * - Trust classification via {@link classifyCommentAuthor} from the shared
 *   comment trust filter.
 * - Suspicious-pattern detection via {@link detectSuspiciousPatterns} from
 *   `security.ts`.
 *
 * The neutralised output (delimiter sanitising + nonce-boundary wrapping) is
 * produced downstream by `buildIssuePrompt` in `prompt_builder.ts`; this
 * module owns the trust classification and the structured security-audit
 * events that replace the old audit-only console warning.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  classifyCommentAuthor,
  type CommentTrustOptions,
  type TrustLevel,
} from "./comment_trust_filter.ts";
import { detectSuspiciousPatterns } from "./security.ts";
import {
  describeUntrustedImages,
  findImageReferences,
  type ImageReference,
} from "./untrusted_image_signal.ts";

/** Trust options needed to classify an issue author. */
export type IssueAuthorTrustOptions = Pick<
  CommentTrustOptions,
  "allowedAuthors" | "authorisedCommenters"
>;

/** Result of trust-filtering the issue body + title. */
export interface IssueContentTrustResult {
  /** Trust level of the issue author. */
  trustLevel: TrustLevel;
  /** Whether suspicious patterns were detected in the title. */
  titleSuspicious: boolean;
  /** Whether suspicious patterns were detected in the body. */
  bodySuspicious: boolean;
  /**
   * Image references carried by an untrusted body (Refs #1385).
   *
   * Observed here, in TypeScript, before the body reaches the agent — so the
   * fact that an untrusted author put an image in front of it does not depend
   * on the model emitting its own suspicious-image marker, which an image can
   * instruct it to withhold. Recorded only; nothing gates on it.
   */
  untrustedImages: ImageReference[];
  /**
   * Security-audit messages, one per suspicious field, for logging as a
   * structured security-audit event. Empty for trusted authors (fast path)
   * and for untrusted authors with no suspicious content.
   */
  securityAuditMessages: string[];
}

/**
 * Observe the image references an **untrusted** author put in the issue body
 * (Issue #1385).
 *
 * The single place that decides "an untrusted party showed the agent a
 * picture". Both routes into `workOnIssue` — the `work-on-issue` command and
 * the main loop's `processIssue` — call it, because the gate that consumes it
 * (`image_conclusion_gate.ts`) is only a control on the routes that observe.
 *
 * A trusted author's images are not the signal, so they are not returned: the
 * trusted fast path stays exactly as it was.
 *
 * @param author - The issue author's GitHub login
 * @param body - The issue body, as fetched, before it reaches the agent
 * @param options - Trust configuration (allowed authors + authorised commenters)
 * @returns One entry per distinct image URL; empty for a trusted author or a
 *   body with no images
 */
export function observeUntrustedIssueImages(
  author: string,
  body: string,
  options: IssueAuthorTrustOptions,
): ImageReference[] {
  if (classifyCommentAuthor(author, options) === "TRUSTED") return [];
  return findImageReferences(body);
}

/**
 * Trust-filter the issue body + title, mirroring the untrusted-comment path.
 *
 * Only an **untrusted** issue author's suspicious content is a genuine
 * security signal, so detection runs for untrusted authors only — the
 * trusted-author fast path is preserved (no detection, no audit events),
 * matching the comment behaviour where trusted comments skip detection.
 *
 * @param author - The issue author's GitHub login
 * @param title - The issue title
 * @param body - The issue body
 * @param options - Trust configuration (allowed authors + authorised commenters)
 * @returns Trust classification and any security-audit messages
 */
export function annotateIssueContentWithTrust(
  author: string,
  title: string,
  body: string,
  options: IssueAuthorTrustOptions,
): IssueContentTrustResult {
  const trustLevel = classifyCommentAuthor(author, options);

  // Trusted authors take the fast path — no detection, no audit events.
  if (trustLevel === "TRUSTED") {
    return {
      trustLevel,
      titleSuspicious: false,
      bodySuspicious: false,
      untrustedImages: [],
      securityAuditMessages: [],
    };
  }

  const titleResult = detectSuspiciousPatterns(title, "issue title");
  const bodyResult = detectSuspiciousPatterns(body, "issue body");

  const securityAuditMessages: string[] = [];
  const authorLabel = author || "(unknown author)";
  if (titleResult.detected) {
    securityAuditMessages.push(
      `[SECURITY] Suspicious patterns detected in untrusted issue title ` +
        `from ${authorLabel}: ${titleResult.context}`,
    );
  }
  if (bodyResult.detected) {
    securityAuditMessages.push(
      `[SECURITY] Suspicious patterns detected in untrusted issue body ` +
        `from ${authorLabel}: ${bodyResult.context}`,
    );
  }

  // Refs #1385: an independent observation, not a self-report. The agent may
  // be persuaded to stay quiet about an image; the reference is already in the
  // text the worker parsed before the agent saw any of it.
  const untrustedImages = observeUntrustedIssueImages(author, body, options);
  const imageMessage = describeUntrustedImages(
    untrustedImages,
    authorLabel,
    "issue body",
  );
  if (imageMessage) securityAuditMessages.push(imageMessage);

  return {
    trustLevel,
    titleSuspicious: titleResult.detected,
    bodySuspicious: bodyResult.detected,
    untrustedImages,
    securityAuditMessages,
  };
}
