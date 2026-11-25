/**
 * Escape-hatch detection for PR feedback / CI fix / issue work (Issue #1826).
 *
 * When a Claude task is genuinely too large or out of scope, the prompts
 * instruct it to:
 *   1. Open a follow-up GitHub issue capturing what was learnt.
 *   2. Post one comment naming the follow-up issue (e.g. `org/repo#NNN`),
 *      explaining briefly why this could not be resolved in-line, and
 *      optionally adding the `needs-human` label.
 *   3. Exit cleanly without retrying the original change.
 *
 * The worker treats such a response as a **successful resolution** rather
 * than a failure to retry — the work has been handed off, not abandoned.
 *
 * Detection is heuristic: we look for a same-repo issue link in the
 * response message. The detector is deliberately conservative — false
 * negatives just lose the optimisation, but false positives would suppress
 * the regular no-changes reply.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Result of escape-hatch detection. */
export interface EscapeHatchDetection {
  /** True when the message indicates the escape hatch was invoked. */
  invoked: boolean;
  /** The follow-up issue reference (e.g. `org/repo#123` or `#123`). */
  issueRef?: string;
  /** True when the message asks for `needs-human` triage. */
  needsHuman: boolean;
}

/** Negative detection result helper. */
const NEGATIVE: EscapeHatchDetection = { invoked: false, needsHuman: false };

/**
 * Detect whether a Claude-authored response message invoked the escape hatch.
 *
 * Heuristics:
 *   - Presence of a same-repo issue reference (`owner/repo#NNN`) or a
 *     bare `#NNN` reference somewhere in the message.
 *   - Presence of follow-up wording such as "follow-up issue", "raised
 *     issue", "opened issue", or "out of scope".
 *
 * Both signals must be present to avoid matching incidental issue links
 * (e.g. a fix message that says "see #42 for context").
 *
 * @param message - The message body Claude wrote (typically the contents
 *                  of `.pr_response_message`). May be `undefined`.
 * @param repo - Repository in `owner/repo` form. Used to recognise a
 *               same-repo full reference (`owner/repo#NNN`).
 * @returns Detection result. `invoked: false` when no message is supplied.
 */
export function detectEscapeHatch(
  message: string | undefined,
  repo: string,
): EscapeHatchDetection {
  if (!message) return NEGATIVE;
  const trimmed = message.trim();
  if (trimmed.length === 0) return NEGATIVE;

  const issueRef = findIssueReference(trimmed, repo);
  if (!issueRef) return NEGATIVE;

  if (!hasFollowUpWording(trimmed)) return NEGATIVE;

  return {
    invoked: true,
    issueRef,
    needsHuman: detectNeedsHuman(trimmed),
  };
}

/** Full `owner/repo#NNN` match tried at one start position. */
const FULL_REF_AT = /([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+)#(\d+)/y;
/** Next possible start of a reference. */
const ALNUM = /[A-Za-z0-9]/g;
/** Maximal run of name characters starting at a failed start. */
const NAME_RUN = /[A-Za-z0-9._-]*/y;

/**
 * Yield each `owner/repo#NNN` reference as `${slug}#${number}`, in order.
 *
 * Same matches as the global `FULL_REF_AT` regex under `matchAll`, but
 * linear. The old regex was quadratic in the length of a name-character
 * run and blocked the worker's event loop (Issue #5544).
 */
function* fullReferences(message: string): Generator<string> {
  let i = 0;
  while (i < message.length) {
    ALNUM.lastIndex = i;
    const alnum = ALNUM.exec(message);
    if (!alnum) return;
    i = alnum.index;
    FULL_REF_AT.lastIndex = i;
    const m = FULL_REF_AT.exec(message);
    if (m) {
      const end = FULL_REF_AT.lastIndex;
      yield `${m[1]}#${m[2]}`;
      i = end;
      continue;
    }
    // Every start inside this run meets the same `/` and fails the same way.
    NAME_RUN.lastIndex = i;
    const run = NAME_RUN.exec(message);
    i = Math.max(i + 1, i + (run ? run[0].length : 0));
  }
}

/**
 * Find the first plausible follow-up issue reference in a message.
 *
 * Prefers a fully-qualified `owner/repo#NNN` reference matching the
 * supplied repo. Falls back to any `owner/repo#NNN` (e.g. when the LLM
 * gets the slug right but capitalises it differently). Last resort is a
 * bare `#NNN` reference.
 */
function findIssueReference(
  message: string,
  repo: string,
): string | undefined {
  const repoLower = repo.toLowerCase();
  let firstFull: string | undefined;
  for (const ref of fullReferences(message)) {
    const slug = ref.slice(0, ref.indexOf("#"));
    if (slug.toLowerCase() === repoLower) {
      return ref;
    }
    if (!firstFull) firstFull = ref;
  }
  if (firstFull) return firstFull;

  // Bare #NNN (avoid trailing punctuation by anchoring to digits only)
  const barePattern = /(?:^|[\s(\[])#(\d+)\b/;
  const bare = barePattern.exec(message);
  if (bare && bare[1]) {
    return `#${bare[1]}`;
  }
  return undefined;
}

/**
 * Recognise the prose markers that distinguish an escape-hatch comment
 * from an incidental issue mention in a "fix applied" reply.
 */
function hasFollowUpWording(message: string): boolean {
  const lower = message.toLowerCase();
  const markers = [
    "follow-up issue",
    "follow up issue",
    "followup issue",
    "raised issue",
    "raised a follow",
    "opened issue",
    "opened a follow",
    "opened a new issue",
    "filed issue",
    "filed a follow",
    "out of scope",
    "out-of-scope",
    "escape hatch",
    "escape-hatch",
    "handing off",
    "hand off",
    "handed off",
    "tracked separately",
    "track separately",
    "tracking separately",
  ];
  return markers.some((marker) => lower.includes(marker));
}

/**
 * Detect whether the message asks for `needs-human` triage.
 *
 * Matches an explicit mention of the `needs-human` label, regardless of
 * whether it appears as code (\`needs-human\`) or plain prose.
 */
function detectNeedsHuman(message: string): boolean {
  return /needs[\s-]?human/i.test(message);
}
