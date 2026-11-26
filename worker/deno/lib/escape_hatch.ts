/**
 * Escape-hatch detection for PR feedback / CI fix / issue work (Issue #1826).
 *
 * Models can still emit follow-up references and hand-off wording even
 * though the issue and PR-feedback prompts require finishing approved work.
 * Detection is retained for follow-up label stripping and legacy PR-feedback
 * hand-off handling; it does not itself verify the referenced issue.
 *
 * Detection is heuristic: we look for an issue reference in the
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
 *   - Presence of a full issue reference (`owner/repo#NNN`) or a
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
 * @param readCode - Character reader for the reference scan; defaults to the
 *                   string reader. Injectable for deterministic work counts.
 * @returns Detection result. `invoked: false` when no message is supplied.
 */
export function detectEscapeHatch(
  message: string | undefined,
  repo: string,
  readCode: (text: string, index: number) => number = (text, index) =>
    text.charCodeAt(index),
): EscapeHatchDetection {
  if (!message) return NEGATIVE;
  const trimmed = message.trim();
  if (trimmed.length === 0) return NEGATIVE;

  const issueRef = findIssueReference(trimmed, repo, readCode);
  if (!issueRef) return NEGATIVE;

  if (!hasFollowUpWording(trimmed)) return NEGATIVE;

  return {
    invoked: true,
    issueRef,
    needsHuman: detectNeedsHuman(trimmed),
  };
}

/** ASCII letters and digits, as accepted at the start of an owner. */
function isAlnum(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122);
}

/** ASCII name characters shared by owners and repositories. */
function isNameCode(code: number): boolean {
  return isAlnum(code) || code === 46 || code === 95 || code === 45;
}

/**
 * Yield the old global regex's `owner/repo#NNN` matches in order.
 * A failed start skips its whole owner run: every suffix fails at the same
 * separator. The following run can still be an owner (e.g. `a/b/c#1`), so
 * leave it for the next iteration. Each name run is read at most twice.
 */
function* fullReferences(
  message: string,
  readCode: (text: string, index: number) => number,
): Generator<string> {
  const codeAt = (index: number) => readCode(message, index);
  let i = 0;
  while (i < message.length) {
    if (!isAlnum(codeAt(i))) {
      i++;
      continue;
    }
    const start = i++;
    while (i < message.length && isNameCode(codeAt(i))) i++;
    const ownerEnd = i;
    if (codeAt(i) !== 47) continue; // `/`

    const repoStart = ++i;
    while (i < message.length && isNameCode(codeAt(i))) i++;
    if (i > repoStart && codeAt(i) === 35) { // `#`
      const digitsStart = ++i;
      while (i < message.length) {
        const code = codeAt(i);
        if (code < 48 || code > 57) break;
        i++;
      }
      if (i > digitsStart) {
        yield message.slice(start, i);
        continue;
      }
    }
    i = ownerEnd + 1;
  }
}

/**
 * Find the first plausible follow-up issue reference in a message.
 *
 * Prefers a fully-qualified `owner/repo#NNN` reference matching the
 * supplied repo (case-insensitive). Falls back to the first other full
 * reference. Last resort is a bare `#NNN` reference.
 */
function findIssueReference(
  message: string,
  repo: string,
  readCode: (text: string, index: number) => number,
): string | undefined {
  const repoLower = repo.toLowerCase();
  let firstFull: string | undefined;
  for (const ref of fullReferences(message, readCode)) {
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
