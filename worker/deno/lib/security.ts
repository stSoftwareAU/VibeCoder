/**
 * Security and input validation utilities for the Vibe Coder worker.
 *
 * Provides defence-in-depth against prompt injection attacks.
 * These functions LOG but do NOT BLOCK — ALLOWED_AUTHOR is trusted.
 *
 * Migrated from worker/shared/security.sh (Issue #903).
 * Original: Issue #30 — Prompt injection defence.
 * Issue #36 — Security hardening for authorised commenters.
 */

import { isBotLogin } from "./trust_exclusions.ts";
import { normaliseLogin } from "./identity_guard.ts";

/** Default maximum length for issue titles. */
export const DEFAULT_MAX_TITLE_LENGTH = 500;

/** Default maximum length for issue bodies. */
export const DEFAULT_MAX_BODY_LENGTH = 50000;

/**
 * Longest bounded gap between two tokens of a multi-token rule.
 *
 * Replaces a bare `.*` (Issue #3665). The gap spans newlines — issue bodies are
 * multi-line Markdown, so an unbounded-but-line-bound `.*` missed every payload
 * carrying a line break. The upper bound keeps a failed match cheap on a
 * 50,000-byte body rather than quadratic.
 */
const GAP_CHARS = 200;

/** Longest single token any rule matches (`instructions` is 12). */
const TOKEN_CHARS = 20;

/**
 * Express a multi-token rule as independent bounded lookaheads (Issue #1274).
 *
 * Four rules chained two or three `GAP`s in sequence — `what GAP are GAP your
 * GAP instructions`. Consecutive gaps are *nested* quantifiers: a failed match
 * retries every combination of gap lengths, up to 200³ per start offset, and
 * this scanner runs over every untrusted comment untruncated on the worker's
 * only thread (50 KB of `what-are-your…` measured at 540 ms).
 *
 * Anchoring each later token to the **head** token instead makes the cost
 * additive rather than multiplicative: each lookahead scans its own window once
 * and none of them can be re-driven by another's failure. The windows widen by
 * one gap plus one token per hop, so every payload the nested form matched
 * still matches — a token reachable through k chained gaps lies within
 * `k × (GAP + TOKEN_CHARS)` characters of the head. The rewrite is deliberately
 * a *superset*: it also fires when the middle tokens appear out of order inside
 * the window. This detector logs and never blocks, so a slightly wider net
 * costs an audit line, while a narrower one would lose a detection.
 *
 * No input cap is applied: capping would silently blind the scanner to the tail
 * of a body, which is where an attacker would then put the payload.
 *
 * @param head - Leading token of the rule, matched literally in sequence
 * @param tail - Later tokens, each anchored to `head` by its own window
 * @returns The rule as a single regex source fragment
 */
function proximityRule(head: string, ...tail: string[]): string {
  return head + tail
    .map((token, hop) => {
      const window = (hop + 1) * (GAP_CHARS + TOKEN_CHARS) - TOKEN_CHARS;
      return `(?=[\\s\\S]{0,${window}}${token})`;
    })
    .join("");
}

/**
 * Combined regex for suspicious prompt injection patterns.
 *
 * Compiled with `is`: case-insensitive, and dotAll so `.` spans line
 * terminators (Issue #3665).
 *
 * Pattern categories:
 * 1. Instruction override — "ignore/disregard/forget ... instructions"
 * 2. System prompt probing — "system prompt", "what are your instructions"
 * 3. Jailbreak patterns — DAN, jailbreak, developer mode bypass
 * 4. Roleplay override — "from now on you are", "pretend to be", "act as if"
 * 5. Hidden instruction markers — HTML comments with suspicious keywords
 * 6. Base64 obfuscation — "base64 decode", "eval base64"
 */
const SUSPICIOUS_PATTERN = new RegExp(
  [
    proximityRule(
      "(?:ignore|disregard|forget)\\b",
      "\\b(?:previous|prior|above|all|your)\\b",
      "\\binstructions\\b",
    ),
    "system\\s+prompt",
    proximityRule("what\\b", "\\bare\\b", "\\byour\\b", "\\binstructions\\b"),
    proximityRule("show\\b", "\\bme\\b", "\\byour\\b", "\\bprompt\\b"),
    proximityRule("reveal\\b", "\\byour\\b", "\\binstructions\\b"),
    "you\\b.are\\b.now\\b.DAN\\b",
    proximityRule("\\bDAN\\b", "\\bmode\\b"),
    proximityRule(
      "developer\\s+mode",
      "(?:bypass|unlock|activat|restrict|enabl)",
    ),
    "\\bjailbreak\\b",
    proximityRule("from\\b.now\\b.on\\b", "\\byou\\b.are\\b"),
    "\\bpretend\\s+to\\s+be\\b",
    "\\bact\\s+as\\s+if\\b",
    "you\\b.are\\b.a\\b.different\\b",
    proximityRule("<!--", "\\binstructions\\b", "-->"),
    proximityRule("<!--", "\\bhidden\\b", "-->"),
    proximityRule("<!--", "\\bignore\\b", "-->"),
    proximityRule("base64", "\\bdecode\\b"),
    proximityRule("\\beval\\b", "\\bbase64\\b"),
  ].join("|"),
  "is",
);

/** Result of a suspicious pattern detection check. */
export interface SuspiciousPatternResult {
  /** Whether suspicious patterns were detected. */
  detected: boolean;
  /** The context in which the content was scanned. */
  context: string;
}

/** Result of an input length validation. */
export interface InputLengthResult {
  /** The actual length of the content in characters. */
  actualLength: number;
  /** Whether the length exceeded the limit. */
  exceeded: boolean;
  /** The field name that was validated. */
  fieldName: string;
  /** The maximum length that was applied. */
  maxLength: number;
}

/** Result of combined issue input validation. */
export interface IssueValidationResult {
  /** Title length in characters. */
  titleLength: number;
  /** Body length in characters. */
  bodyLength: number;
  /** Whether suspicious patterns were found in the title. */
  titleSuspicious: boolean;
  /** Whether suspicious patterns were found in the body. */
  bodySuspicious: boolean;
}

/** Result of a bot account audit. */
export interface BotAuditResult {
  /** Number of bot accounts found. */
  botCount: number;
  /** Names of the bot accounts detected. */
  botNames: string[];
}

/**
 * Detect potentially suspicious patterns in content.
 *
 * Scans content for patterns commonly used in prompt injection attacks.
 * This is a defence-in-depth measure — it does NOT block execution.
 *
 * @param content - The text content to scan
 * @param context - Description of where this content came from (e.g., "issue body")
 * @returns Whether suspicious patterns were detected
 */
export function detectSuspiciousPatterns(
  content: string,
  context = "content",
): SuspiciousPatternResult {
  if (!content) {
    return { detected: false, context };
  }

  const detected = SUSPICIOUS_PATTERN.test(content);
  return { detected, context };
}

/**
 * Validate content length against a limit.
 *
 * @param content - The text content to measure
 * @param fieldName - Name of the field (e.g., "title", "body")
 * @param maxLength - Maximum allowed length
 * @returns Validation result with actual length and whether limit was exceeded
 */
export function validateInputLength(
  content: string,
  fieldName = "content",
  maxLength = DEFAULT_MAX_BODY_LENGTH,
): InputLengthResult {
  const actualLength = new TextEncoder().encode(content).length;
  const exceeded = actualLength > maxLength;

  return { actualLength, exceeded, fieldName, maxLength };
}

/**
 * Validate issue title and body for suspicious content.
 *
 * Performs comprehensive input validation on issue content:
 * 1. Checks for suspicious patterns in title and body
 * 2. Validates length limits
 *
 * This is a defence-in-depth measure. It returns results but does NOT block
 * because ALLOWED_AUTHOR is trusted. The audit trail helps detect potential
 * account compromise or misconfiguration.
 *
 * @param title - The issue title
 * @param body - The issue body
 * @param maxTitleLength - Maximum allowed title length
 * @param maxBodyLength - Maximum allowed body length
 * @returns Combined validation result
 */
export function validateIssueInput(
  title: string,
  body: string,
  maxTitleLength = DEFAULT_MAX_TITLE_LENGTH,
  maxBodyLength = DEFAULT_MAX_BODY_LENGTH,
): IssueValidationResult {
  const titlePatterns = detectSuspiciousPatterns(title, "issue title");
  const bodyPatterns = detectSuspiciousPatterns(body, "issue body");

  const titleLengthResult = validateInputLength(title, "title", maxTitleLength);
  const bodyLengthResult = validateInputLength(body, "body", maxBodyLength);

  return {
    titleLength: titleLengthResult.actualLength,
    bodyLength: bodyLengthResult.actualLength,
    titleSuspicious: titlePatterns.detected,
    bodySuspicious: bodyPatterns.detected,
  };
}

/** Outcome of enforcing the issue-body byte limit (Issue #3648). */
export interface IssueBodyLimitResult {
  /** The body, truncated with an explicit notice when over the limit. */
  body: string;
  /** Whether truncation was applied. */
  truncated: boolean;
  /** Byte length of the original body. */
  originalLength: number;
  /** The limit applied, in bytes. */
  maxBodyLength: number;
}

/**
 * Truncate a UTF-8 string to at most `maxBytes` bytes without splitting a
 * multi-byte character.
 */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;
  let out = new TextDecoder("utf-8").decode(encoded.slice(0, maxBytes));
  // A cut mid-sequence decodes to a trailing replacement character — drop it.
  if (out.endsWith("�")) out = out.slice(0, -1);
  return out;
}

/**
 * Enforce {@link DEFAULT_MAX_BODY_LENGTH} on an issue body (Issue #3648).
 *
 * `validateIssueInput` measures the body but neither truncates nor throws, and
 * its only caller discarded the result — so the documented 50,000-byte limit
 * was dead code and an oversized body flowed into the prompt in full. This is
 * the enforcing counterpart: it bounds the body and announces the truncation
 * so a clipped body never reads as the complete issue.
 *
 * @param body - The raw issue body
 * @param maxBodyLength - Byte limit (defaults to {@link DEFAULT_MAX_BODY_LENGTH})
 * @returns The bounded body plus the metadata needed to log the event
 */
export function enforceIssueBodyLimit(
  body: string,
  maxBodyLength = DEFAULT_MAX_BODY_LENGTH,
): IssueBodyLimitResult {
  const originalLength = new TextEncoder().encode(body).length;
  if (originalLength <= maxBodyLength) {
    return { body, truncated: false, originalLength, maxBodyLength };
  }
  const omitted = originalLength - maxBodyLength;
  return {
    body: `${truncateUtf8(body, maxBodyLength)}\n\n` +
      `[Issue body truncated — ${omitted} bytes omitted ` +
      `(limit: ${maxBodyLength} bytes).]`,
    truncated: true,
    originalLength,
    maxBodyLength,
  };
}

/**
 * Check if a user is authorised to trigger PR feedback processing.
 *
 * Case-insensitive, because GitHub logins are (Issue #1066). The list is now
 * the *derived* set, whose collaborator logins are normalised to lower case
 * by `normaliseLogin`, while a comment author arrives in whatever casing the
 * account uses. An exact match would have silently dropped every commenter
 * whose login carries a capital — the fleet's own `VibeCoderST` included.
 *
 * @param commenter - The GitHub username to check
 * @param authorisedCommenters - List of authorised commenter usernames
 * @returns Whether the commenter is authorised
 */
export function isAuthorisedCommenter(
  commenter: string,
  authorisedCommenters: string[],
): boolean {
  const key = normaliseLogin(commenter);
  if (!key) return false;
  return authorisedCommenters.some(
    (a) => typeof a === "string" && normaliseLogin(a) === key,
  );
}

/**
 * Identify bot accounts in the authorised commenters list.
 *
 * Bot accounts are identified by common patterns (e.g., [bot] suffix,
 * known bot identifiers). The ALLOWED_AUTHOR is skipped even if it
 * matches a bot pattern.
 *
 * This function provides audit visibility only — it does NOT block.
 *
 * @param authorisedCommenters - List of authorised commenter usernames
 * @param allowedAuthor - The primary allowed author to skip
 * @returns Audit result with bot count and names
 */
export function detectBotAccounts(
  authorisedCommenters: string[],
  allowedAuthor?: string,
): BotAuditResult {
  const botNames: string[] = [];

  for (const commenter of authorisedCommenters) {
    if (!commenter) continue;
    if (allowedAuthor && commenter === allowedAuthor) continue;

    if (isBotLogin(commenter)) {
      botNames.push(commenter);
    }
  }

  return { botCount: botNames.length, botNames };
}
