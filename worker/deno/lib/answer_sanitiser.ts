/**
 * Claude output sanitisation (Issue #332, #913).
 *
 * When Claude runs in --print mode for question answering, it may generate
 * meta-commentary about being unable to post comments or lacking permissions.
 * This module strips such meta-commentary and extracts the actual answer
 * content.
 *
 * Migrated from worker/shared/answer_sanitiser.sh.
 *
 * Secret redaction (Issue #3195): the sanitised answer is posted verbatim to a
 * public GitHub issue comment — the highest-value outbound sink, since comments
 * are public and permanent. Every returned answer is routed through
 * `redactSecrets()` so a token the model emitted into its answer (e.g. a
 * `GH_TOKEN` or `sk-ant-…` reachable in the Claude subprocess environment) is
 * masked before it can be posted, mirroring the defence-in-depth redaction the
 * logger (`logger.ts`) and crash notifications (`crash_notification.ts`) already
 * apply on their sinks.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { redactSecrets } from "./secret_redaction.ts";

/**
 * Patterns that indicate meta-commentary about inability to post.
 * Matched case-insensitively against the first paragraph of output.
 */
const POSTING_PATTERNS: readonly RegExp[] = [
  /(unable to post|cannot post|can't post|could not post|couldn't post).*(comment|answer|response)/i,
  /(permission restrictions|don't have permission|do not have permission).*(post|comment|answer)/i,
  /^(due to|because of) permission.*(unable|cannot|can't)/i,
];

/** Matches horizontal rule separators (---, ===, ***). */
const SEPARATOR_RE = /^\s*[-=*]{3,}\s*$/;

/** Matches the duplicate "## Answer" header. */
const ANSWER_HEADER_RE = /^## Answer\s*$/;

/**
 * Extract the first paragraph from text (non-blank lines before the first
 * blank line).
 */
function extractFirstParagraph(text: string): string {
  const lines = text.split("\n");
  const paragraphLines: string[] = [];
  let started = false;

  for (const line of lines) {
    if (line.trim().length > 0) {
      started = true;
      paragraphLines.push(line);
    } else if (started) {
      break;
    }
  }

  return paragraphLines.join("\n");
}

/**
 * Check whether the first paragraph contains meta-commentary about
 * inability to post or permission restrictions.
 */
function isMetaCommentary(firstParagraph: string): boolean {
  for (const pattern of POSTING_PATTERNS) {
    if (pattern.test(firstParagraph)) {
      return true;
    }
  }
  return false;
}

/**
 * Sanitise Claude's answer output by removing meta-commentary preambles.
 *
 * Detects and removes preambles where Claude claims it cannot post a comment
 * or lacks permissions. Extracts the actual answer content that follows.
 *
 * @param rawOutput - The raw output from Claude's --print mode
 * @returns The sanitised answer (may be empty if no real content remains)
 */
export function sanitiseAnswerOutput(rawOutput: string): string {
  if (!rawOutput) return "";

  const firstParagraph = extractFirstParagraph(rawOutput);

  if (!isMetaCommentary(firstParagraph)) {
    // Redact secrets before the answer leaves this chokepoint (Issue #3195).
    return redactSecrets(rawOutput);
  }

  // Strip the meta-commentary preamble and extract the actual answer.
  // Skip: first paragraph (meta-commentary), then blank lines,
  // then optional separator lines (---, ===, ***), then blank lines.
  const lines = rawOutput.split("\n");
  let i = 0;

  // Skip the first paragraph (non-blank lines)
  let inFirstParagraph = false;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim().length > 0) {
      inFirstParagraph = true;
      i++;
    } else if (inFirstParagraph) {
      break;
    } else {
      i++;
    }
  }

  // Skip blank lines after preamble
  while (i < lines.length && (lines[i] ?? "").trim().length === 0) {
    i++;
  }

  // Skip separator lines and blank lines after separator
  const sepLine = lines[i];
  if (sepLine !== undefined && SEPARATOR_RE.test(sepLine)) {
    i++;
    while (i < lines.length && (lines[i] ?? "").trim().length === 0) {
      i++;
    }
  }

  // Remaining content
  let remaining = lines.slice(i).join("\n");

  // Strip duplicate "## Answer" header
  const remainingLines = remaining.split("\n");
  const filtered: string[] = [];
  let skipNextBlank = false;
  for (const line of remainingLines) {
    if (ANSWER_HEADER_RE.test(line)) {
      skipNextBlank = true;
      continue;
    }
    if (skipNextBlank && line.trim().length === 0) {
      skipNextBlank = false;
      continue;
    }
    skipNextBlank = false;
    filtered.push(line);
  }
  remaining = filtered.join("\n");

  // Remove leading blank lines
  remaining = remaining.replace(/^\n+/, "");

  // Redact secrets before the answer leaves this chokepoint (Issue #3195).
  return redactSecrets(remaining);
}
