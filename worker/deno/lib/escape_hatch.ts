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
  // Match owner/repo#NNN (case-insensitive owner/repo)
  const fullPattern = /([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+)#(\d+)/g;
  const repoLower = repo.toLowerCase();
  let firstFull: string | undefined;
  for (const m of message.matchAll(fullPattern)) {
    const slug = m[1];
    const number = m[2];
    if (!slug || !number) continue;
    const ref = `${slug}#${number}`;
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
