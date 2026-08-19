/**
 * Keep idle-task wrapper bodies inside GitHub's issue-body limit (Issue #3634).
 *
 * An idle-task wrapper body is a *preview* of the scan prompt: it is filed so a
 * human reading the issue sees the fully-substituted prompt, while the scan
 * itself re-loads the canonical prompt from `prompts/<scan>/vN.md` at run time
 * (`template.runTask`). Prompts grow — `security_scan` v28 builds an 84,454
 * character body — and GitHub rejects any issue body over 65,536 characters
 * with `GraphQL: Body is too long (maximum is 65536 characters)`. That failure
 * aborted the whole seeding sweep, so no wrapper landed at all.
 *
 * {@link clampIdleTaskBody} clamps an over-long body to fit, keeping the parts
 * that carry meaning:
 *
 *   - the **head**, which holds each template's body fingerprint heading (the
 *     fallback dispatch signal in `idle_task_claim_handler.ts`);
 *   - the **tail**, from the attribution footer onwards, which holds the
 *     template name and the machine-readable run id.
 *
 * The dropped span is replaced by a visible notice naming the exact number of
 * characters removed — the body never shrinks silently, and the caller gets a
 * `truncated` flag to log loudly as well.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { ATTRIBUTION_FOOTER_PREFIX } from "./idle_task_attribution.ts";

/** GitHub's hard ceiling on an issue body, in characters. */
export const GITHUB_ISSUE_BODY_MAX_CHARS = 65_536;

/** Leading text of the visible truncation notice. Greppable and stable. */
export const IDLE_TASK_BODY_TRUNCATION_MARKER =
  "⚠️ **Preview truncated to fit GitHub's issue-body limit.**";

/**
 * Characters reserved for the truncation notice when budgeting the head. The
 * notice is a fixed sentence plus two numbers, so this is comfortably ample.
 */
const NOTICE_RESERVE_CHARS = 512;

/** Outcome of {@link clampIdleTaskBody}. */
export interface ClampedIdleTaskBody {
  /** The body to file — always at or under the limit. */
  body: string;
  /** True when characters were dropped. */
  truncated: boolean;
  /** Length of the body handed in. */
  originalLength: number;
  /** Number of characters dropped from the middle. Zero when untruncated. */
  droppedChars: number;
}

/** Options accepted by {@link clampIdleTaskBody}. */
export interface ClampIdleTaskBodyOptions {
  /** Override the limit. Defaults to {@link GITHUB_ISSUE_BODY_MAX_CHARS}. */
  maxChars?: number;
}

/** Build the visible notice that replaces the dropped span. */
function buildNotice(dropped: number, originalLength: number): string {
  return [
    `> ${IDLE_TASK_BODY_TRUNCATION_MARKER}`,
    `> ${dropped} of ${originalLength} characters were dropped from the`,
    "> middle of this preview. The scan itself is unaffected — it re-loads the",
    "> full prompt from `prompts/` at run time, not from this issue body.",
  ].join("\n");
}

/**
 * Split `body` into the part before the attribution footer and the footer tail.
 * Returns an empty tail when no footer is present.
 */
function splitAtAttributionFooter(body: string): [string, string] {
  const idx = body.lastIndexOf(ATTRIBUTION_FOOTER_PREFIX);
  if (idx === -1) return [body, ""];
  const lineStart = body.lastIndexOf("\n", idx) + 1;
  return [body.slice(0, lineStart), body.slice(lineStart)];
}

/** Trim `text` to at most `budget` characters, cutting on a line boundary. */
function cutOnLineBoundary(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const hard = text.slice(0, budget);
  const lastNewline = hard.lastIndexOf("\n");
  return lastNewline > 0 ? hard.slice(0, lastNewline) : hard;
}

/**
 * Clamp an idle-task wrapper body to GitHub's issue-body limit, preserving the
 * fingerprint head and the attribution tail and announcing the drop in-body.
 *
 * Throws on a non-positive `maxChars` — a caller asking for an impossible
 * budget is a bug, not something to paper over.
 */
export function clampIdleTaskBody(
  body: string,
  opts: ClampIdleTaskBodyOptions = {},
): ClampedIdleTaskBody {
  const maxChars = opts.maxChars ?? GITHUB_ISSUE_BODY_MAX_CHARS;
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new Error(
      `clampIdleTaskBody: maxChars must be a positive number, got ${maxChars}`,
    );
  }

  const originalLength = body.length;
  if (originalLength <= maxChars) {
    return { body, truncated: false, originalLength, droppedChars: 0 };
  }

  const [beforeFooter, footer] = splitAtAttributionFooter(body);
  // Keep the footer only when it still leaves room for a meaningful head.
  const tail = footer.length + NOTICE_RESERVE_CHARS < maxChars ? footer : "";
  const headBudget = maxChars - tail.length - NOTICE_RESERVE_CHARS;
  const head = headBudget > 0
    ? cutOnLineBoundary(beforeFooter, headBudget)
    : "";

  const droppedChars = originalLength - head.length - tail.length;
  const assembled = [head, buildNotice(droppedChars, originalLength), tail]
    .filter((part) => part.length > 0)
    .join("\n\n");

  // Defence in depth: never hand back an over-limit body, even if the notice
  // somehow outgrew its reserve.
  const clamped = assembled.length <= maxChars
    ? assembled
    : assembled.slice(0, maxChars);

  return {
    body: clamped,
    truncated: true,
    originalLength,
    droppedChars: originalLength - head.length - tail.length,
  };
}
