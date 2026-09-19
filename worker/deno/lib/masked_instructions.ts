/**
 * Detect an issue instruction the worker's own masking made unreadable
 * (Issue #2390).
 *
 * The `github-actions-audit` idle task filed fourteen issues reading
 * "Add `persist-credentials: ***REDACTED***` to the checkout step": the secret
 * filter had masked the one value the instruction needed. Nothing downstream
 * noticed — the filer published it and the worker queued and claimed it as
 * ordinary work. An agent handed that text can only guess the value, and in a
 * security finding a wrong guess ships the opposite of the fix.
 *
 * The operator's rule is: **if there is a problem with an issue, ask for
 * clarification — do not proceed on it and do not skip it silently.** This
 * module is the pure judgement both sides share:
 *
 *  - the **filer** (`gh_body_redaction.ts`) uses it to notice that a body it
 *    is about to publish carries a masked instruction, and says so;
 *  - the **pickup path** (`clarity_phase.ts`) uses it to ask, through the
 *    existing `## Clarification Needed` route, before any agent is invoked.
 *
 * ## What counts as an instruction
 *
 * Masking is *correct* in a quoted log, so a placeholder is not a fault by
 * itself. A hit is a line carrying a placeholder that is:
 *
 *  - **not** in a blockquote (`>` — quoted output);
 *  - **not** under a heading that names evidence (`Evidence`, `Logs`,
 *    `Output`, `Why this matters`, …);
 *  - when inside a code fence, under a heading that names the work
 *    (`Suggested fix`, `Steps`, `Expected`, …) — a fence anywhere else is a
 *    pasted log;
 *  - the secret placeholder standing as the **value of an assignment**
 *    (`key: ***REDACTED***`) — a secret masked in running prose ("found token
 *    ***REDACTED***, rotate it") is masking doing its job;
 *  - **not** the placeholder written as a thing in its own code span
 *    (`` `***REDACTED***` ``) — that is an issue *about* masking.
 *
 * Prose with no heading at all is instruction: a short hand-written issue is
 * nothing but.
 *
 * Pure and linear: one pass over the lines, fixed-string searches, and two
 * anchored heading tests per heading line.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { REDACTION_PLACEHOLDER } from "./secret_redaction.ts";
import { PROMPT_LEAK_PLACEHOLDER } from "./prompt_leak_redaction.ts";

/** Every placeholder the worker's masks substitute. */
export const MASK_PLACEHOLDERS: readonly string[] = [
  REDACTION_PLACEHOLDER,
  PROMPT_LEAK_PLACEHOLDER,
];

/**
 * Hidden marker on the clarification comment that asks for a masked value, so
 * the pickup path can tell its own question has been answered.
 */
export const MASKED_INSTRUCTION_QUESTION_MARKER =
  "<!-- masked-instruction-question -->";

/** One instruction line a mask made unreadable. */
export interface MaskedInstruction {
  /** 1-based line number in the body. */
  line: number;
  /** Heading the line sits under, or `""` before the first heading. */
  section: string;
  /** The line, trimmed and bounded for quoting back to the author. */
  text: string;
}

/** Longest line quoted back in a question. */
const MAX_QUOTED_CHARS = 160;

/** Most lines named in one clarification comment. */
const MAX_QUESTIONS = 5;

/** Bodies longer than this are not scanned — no real issue approaches it. */
const MAX_SCAN_CHARS = 262_144;

// A heading whose section holds evidence: masking there is correct.
const EVIDENCE_HEADING_RE =
  /\b(evidence|logs?|output|errors?|traces?|stack|transcript|observed|actual|what happened|why this matters|background|context|reproduc\w*)\b/i;

// A heading whose section holds the work: a fence there is part of the ask.
const INSTRUCTION_HEADING_RE =
  /\b(fix|fixes|solution|steps?|tasks?|todo|changes?|implement\w*|expected|acceptance|instructions?|proposal|proposed|suggest\w*|requirements?|scope|how)\b/i;

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(```|~~~)/;

/** Remove placeholders written as a thing in their own code span. */
function withoutMentions(line: string): string {
  let out = line;
  for (const placeholder of MASK_PLACEHOLDERS) {
    out = out.replaceAll(`\`${placeholder}\``, "");
  }
  return out;
}

// The secret placeholder standing as the value of an assignment:
// `key: ***REDACTED***`, `KEY=***REDACTED***`, `"key": "***REDACTED***"`.
const MASKED_ASSIGNMENT = new RegExp(
  `[=:]\\s{0,8}["']?${REDACTION_PLACEHOLDER.replaceAll("*", "\\*")}`,
);

/**
 * Does this line carry a masked value the reader needed?
 *
 * A secret masked in running prose — "found token ***REDACTED*** in
 * config.ts, rotate it" — is masking doing its job: nobody needs that value to
 * act. The incident's shape is different: the placeholder is the **value of an
 * assignment** the instruction tells the reader to make. A prompt-leak
 * placeholder is a whole passage removed, so it counts wherever it lands.
 */
function carriesMaskedValue(line: string): boolean {
  return line.includes(PROMPT_LEAK_PLACEHOLDER) ||
    MASKED_ASSIGNMENT.test(line);
}

/**
 * Find the instruction lines of an issue body that carry a mask placeholder.
 *
 * @param body - The issue body as published.
 * @returns One entry per unreadable instruction line, in document order;
 *   empty when the body is workable (or too large to be a real issue).
 */
export function findMaskedInstructions(body: string): MaskedInstruction[] {
  if (body.length > MAX_SCAN_CHARS) return [];
  if (!MASK_PLACEHOLDERS.some((p) => body.includes(p))) return [];

  const hits: MaskedInstruction[] = [];
  let section = "";
  let evidence = false;
  let instruction = false;
  let inFence = false;

  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) {
      const heading = HEADING_RE.exec(line);
      if (heading) {
        section = (heading[1] ?? "").trim();
        evidence = EVIDENCE_HEADING_RE.test(section);
        instruction = INSTRUCTION_HEADING_RE.test(section);
        continue;
      }
    }

    if (evidence) continue;
    if (inFence && !instruction) continue;
    if (!inFence && line.trimStart().startsWith(">")) continue;

    if (!carriesMaskedValue(withoutMentions(line))) continue;

    hits.push({
      line: i + 1,
      section,
      text: line.trim().slice(0, MAX_QUOTED_CHARS),
    });
  }
  return hits;
}

/**
 * The questions posted through the clarification route for masked lines.
 *
 * Every quoted line already carries the placeholder, never the value, so the
 * text is safe to publish; it still passes through the clarification route's
 * own `redactSecrets` like any other question.
 */
export function buildMaskedInstructionQuestions(
  hits: readonly MaskedInstruction[],
): string {
  const shown = hits.slice(0, MAX_QUESTIONS);
  const lines = shown.map((h, n) => {
    const where = h.section ? ` under **${h.section}**` : "";
    return `${n + 1}. On line ${h.line}${where}, a value was masked before ` +
      `this issue was published, so the instruction cannot be followed:\n\n` +
      `   > ${h.text.replaceAll("`", "'")}\n\n` +
      `   What should it say?`;
  });
  const more = hits.length > shown.length
    ? `\n\n…and ${hits.length - shown.length} more masked line(s).`
    : "";
  return lines.join("\n\n") + more + "\n\n" +
    "Please **edit the issue** text to restore the value — that is what the " +
    "worker reads. If the masked value is a **real secret**, do not paste " +
    "it: describe the change without it (name the setting or the secret's " +
    "store, not its value).";
}

/** Notice appended to a worker-authored issue filed with a masked instruction. */
export function buildMaskedInstructionNotice(
  hits: readonly MaskedInstruction[],
): string {
  const where = hits.slice(0, MAX_QUESTIONS).map((h) => `line ${h.line}`)
    .join(", ");
  return "\n\n---\n" +
    "⚠️ **A value in this issue's instructions was masked by the worker's " +
    `secret filter before it was published** (${where}). If the value is not ` +
    "a secret this is a false positive in the filter: restore it by editing " +
    "this issue. The worker will ask for it before working this issue " +
    "rather than guess.";
}
