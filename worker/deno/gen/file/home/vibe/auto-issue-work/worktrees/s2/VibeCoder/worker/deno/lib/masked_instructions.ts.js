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
 *    is about to publish carries a masked instruction, and says so.
 *
 * (A pickup-side check lived in the `clarity-phase` CLI, which nothing in
 * production ran; it went with the clarification hand-off in Issue #4298.)
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
 */ import { REDACTION_PLACEHOLDER } from "./secret_redaction.ts";
import { PROMPT_LEAK_PLACEHOLDER } from "./prompt_leak_redaction.ts";
/** Every placeholder the worker's masks substitute. */ export const MASK_PLACEHOLDERS = [
  REDACTION_PLACEHOLDER,
  PROMPT_LEAK_PLACEHOLDER
];
/**
 * Hidden marker on the clarification comment that asks for a masked value, so
 * the pickup path can tell its own question has been answered.
 */ export const MASKED_INSTRUCTION_QUESTION_MARKER = "<!-- masked-instruction-question -->";
/** Longest line quoted back in a question. */ const MAX_QUOTED_CHARS = 160;
/** Most lines named in one clarification comment. */ const MAX_QUESTIONS = 5;
/** Bodies longer than this are not scanned — no real issue approaches it. */ const MAX_SCAN_CHARS = 262_144;
// A heading whose section holds evidence: masking there is correct.
const EVIDENCE_HEADING_RE = /\b(evidence|logs?|output|errors?|traces?|stack|transcript|observed|actual|what happened|why this matters|background|context|reproduc\w*)\b/i;
// A heading whose section holds the work: a fence there is part of the ask.
const INSTRUCTION_HEADING_RE = /\b(fix|fixes|solution|steps?|tasks?|todo|changes?|implement\w*|expected|acceptance|instructions?|proposal|proposed|suggest\w*|requirements?|scope|how)\b/i;
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(```|~~~)/;
/** Remove placeholders written as a thing in their own code span. */ function withoutMentions(line) {
  let out = line;
  for (const placeholder of MASK_PLACEHOLDERS){
    out = out.replaceAll(`\`${placeholder}\``, "");
  }
  return out;
}
// The secret placeholder standing as the value of an assignment:
// `key: ***REDACTED***`, `KEY=***REDACTED***`, `"key": "***REDACTED***"`.
const MASKED_ASSIGNMENT = new RegExp(`[=:]\\s{0,8}["']?${REDACTION_PLACEHOLDER.replaceAll("*", "\\*")}`);
/**
 * Does this line carry a masked value the reader needed?
 *
 * A secret masked in running prose — "found token ***REDACTED*** in
 * config.ts, rotate it" — is masking doing its job: nobody needs that value to
 * act. The incident's shape is different: the placeholder is the **value of an
 * assignment** the instruction tells the reader to make. A prompt-leak
 * placeholder is a whole passage removed, so it counts wherever it lands.
 */ function carriesMaskedValue(line) {
  return line.includes(PROMPT_LEAK_PLACEHOLDER) || MASKED_ASSIGNMENT.test(line);
}
/**
 * Find the instruction lines of an issue body that carry a mask placeholder.
 *
 * @param body - The issue body as published.
 * @returns One entry per unreadable instruction line, in document order;
 *   empty when the body is workable (or too large to be a real issue).
 */ export function findMaskedInstructions(body) {
  if (body.length > MAX_SCAN_CHARS) return [];
  if (!MASK_PLACEHOLDERS.some((p)=>body.includes(p))) return [];
  const hits = [];
  let section = "";
  let evidence = false;
  let instruction = false;
  let inFence = false;
  const lines = body.split("\n");
  for(let i = 0; i < lines.length; i++){
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
      text: line.trim().slice(0, MAX_QUOTED_CHARS)
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
 */ export function buildMaskedInstructionQuestions(hits) {
  const shown = hits.slice(0, MAX_QUESTIONS);
  const lines = shown.map((h, n)=>{
    const where = h.section ? ` under **${h.section}**` : "";
    return `${n + 1}. On line ${h.line}${where}, a value was masked before ` + `this issue was published, so the instruction cannot be followed:\n\n` + `   > ${h.text.replaceAll("`", "'")}\n\n` + `   What should it say?`;
  });
  const more = hits.length > shown.length ? `\n\n…and ${hits.length - shown.length} more masked line(s).` : "";
  return lines.join("\n\n") + more + "\n\n" + "Please **edit the issue** text to restore the value — that is what the " + "worker reads. If the masked value is a **real secret**, do not paste " + "it: describe the change without it (name the setting or the secret's " + "store, not its value).";
}
/** Notice appended to a worker-authored issue filed with a masked instruction. */ export function buildMaskedInstructionNotice(hits) {
  const where = hits.slice(0, MAX_QUESTIONS).map((h)=>`line ${h.line}`).join(", ");
  return "\n\n---\n" + "⚠️ **A value in this issue's instructions was masked by the worker's " + `secret filter before it was published** (${where}). If the value is not ` + "a secret this is a false positive in the filter: restore it by editing " + "this issue. The worker will ask for it before working this issue " + "rather than guess.";
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9tYXNrZWRfaW5zdHJ1Y3Rpb25zLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogRGV0ZWN0IGFuIGlzc3VlIGluc3RydWN0aW9uIHRoZSB3b3JrZXIncyBvd24gbWFza2luZyBtYWRlIHVucmVhZGFibGVcbiAqIChJc3N1ZSAjMjM5MCkuXG4gKlxuICogVGhlIGBnaXRodWItYWN0aW9ucy1hdWRpdGAgaWRsZSB0YXNrIGZpbGVkIGZvdXJ0ZWVuIGlzc3VlcyByZWFkaW5nXG4gKiBcIkFkZCBgcGVyc2lzdC1jcmVkZW50aWFsczogKioqUkVEQUNURUQqKipgIHRvIHRoZSBjaGVja291dCBzdGVwXCI6IHRoZSBzZWNyZXRcbiAqIGZpbHRlciBoYWQgbWFza2VkIHRoZSBvbmUgdmFsdWUgdGhlIGluc3RydWN0aW9uIG5lZWRlZC4gTm90aGluZyBkb3duc3RyZWFtXG4gKiBub3RpY2VkIOKAlCB0aGUgZmlsZXIgcHVibGlzaGVkIGl0IGFuZCB0aGUgd29ya2VyIHF1ZXVlZCBhbmQgY2xhaW1lZCBpdCBhc1xuICogb3JkaW5hcnkgd29yay4gQW4gYWdlbnQgaGFuZGVkIHRoYXQgdGV4dCBjYW4gb25seSBndWVzcyB0aGUgdmFsdWUsIGFuZCBpbiBhXG4gKiBzZWN1cml0eSBmaW5kaW5nIGEgd3JvbmcgZ3Vlc3Mgc2hpcHMgdGhlIG9wcG9zaXRlIG9mIHRoZSBmaXguXG4gKlxuICogVGhlIG9wZXJhdG9yJ3MgcnVsZSBpczogKippZiB0aGVyZSBpcyBhIHByb2JsZW0gd2l0aCBhbiBpc3N1ZSwgYXNrIGZvclxuICogY2xhcmlmaWNhdGlvbiDigJQgZG8gbm90IHByb2NlZWQgb24gaXQgYW5kIGRvIG5vdCBza2lwIGl0IHNpbGVudGx5LioqIFRoaXNcbiAqIG1vZHVsZSBpcyB0aGUgcHVyZSBqdWRnZW1lbnQgYm90aCBzaWRlcyBzaGFyZTpcbiAqXG4gKiAgLSB0aGUgKipmaWxlcioqIChgZ2hfYm9keV9yZWRhY3Rpb24udHNgKSB1c2VzIGl0IHRvIG5vdGljZSB0aGF0IGEgYm9keSBpdFxuICogICAgaXMgYWJvdXQgdG8gcHVibGlzaCBjYXJyaWVzIGEgbWFza2VkIGluc3RydWN0aW9uLCBhbmQgc2F5cyBzby5cbiAqXG4gKiAoQSBwaWNrdXAtc2lkZSBjaGVjayBsaXZlZCBpbiB0aGUgYGNsYXJpdHktcGhhc2VgIENMSSwgd2hpY2ggbm90aGluZyBpblxuICogcHJvZHVjdGlvbiByYW47IGl0IHdlbnQgd2l0aCB0aGUgY2xhcmlmaWNhdGlvbiBoYW5kLW9mZiBpbiBJc3N1ZSAjNDI5OC4pXG4gKlxuICogIyMgV2hhdCBjb3VudHMgYXMgYW4gaW5zdHJ1Y3Rpb25cbiAqXG4gKiBNYXNraW5nIGlzICpjb3JyZWN0KiBpbiBhIHF1b3RlZCBsb2csIHNvIGEgcGxhY2Vob2xkZXIgaXMgbm90IGEgZmF1bHQgYnlcbiAqIGl0c2VsZi4gQSBoaXQgaXMgYSBsaW5lIGNhcnJ5aW5nIGEgcGxhY2Vob2xkZXIgdGhhdCBpczpcbiAqXG4gKiAgLSAqKm5vdCoqIGluIGEgYmxvY2txdW90ZSAoYD5gIOKAlCBxdW90ZWQgb3V0cHV0KTtcbiAqICAtICoqbm90KiogdW5kZXIgYSBoZWFkaW5nIHRoYXQgbmFtZXMgZXZpZGVuY2UgKGBFdmlkZW5jZWAsIGBMb2dzYCxcbiAqICAgIGBPdXRwdXRgLCBgV2h5IHRoaXMgbWF0dGVyc2AsIOKApik7XG4gKiAgLSB3aGVuIGluc2lkZSBhIGNvZGUgZmVuY2UsIHVuZGVyIGEgaGVhZGluZyB0aGF0IG5hbWVzIHRoZSB3b3JrXG4gKiAgICAoYFN1Z2dlc3RlZCBmaXhgLCBgU3RlcHNgLCBgRXhwZWN0ZWRgLCDigKYpIOKAlCBhIGZlbmNlIGFueXdoZXJlIGVsc2UgaXMgYVxuICogICAgcGFzdGVkIGxvZztcbiAqICAtIHRoZSBzZWNyZXQgcGxhY2Vob2xkZXIgc3RhbmRpbmcgYXMgdGhlICoqdmFsdWUgb2YgYW4gYXNzaWdubWVudCoqXG4gKiAgICAoYGtleTogKioqUkVEQUNURUQqKipgKSDigJQgYSBzZWNyZXQgbWFza2VkIGluIHJ1bm5pbmcgcHJvc2UgKFwiZm91bmQgdG9rZW5cbiAqICAgICoqKlJFREFDVEVEKioqLCByb3RhdGUgaXRcIikgaXMgbWFza2luZyBkb2luZyBpdHMgam9iO1xuICogIC0gKipub3QqKiB0aGUgcGxhY2Vob2xkZXIgd3JpdHRlbiBhcyBhIHRoaW5nIGluIGl0cyBvd24gY29kZSBzcGFuXG4gKiAgICAoYGAgYCoqKlJFREFDVEVEKioqYCBgYCkg4oCUIHRoYXQgaXMgYW4gaXNzdWUgKmFib3V0KiBtYXNraW5nLlxuICpcbiAqIFByb3NlIHdpdGggbm8gaGVhZGluZyBhdCBhbGwgaXMgaW5zdHJ1Y3Rpb246IGEgc2hvcnQgaGFuZC13cml0dGVuIGlzc3VlIGlzXG4gKiBub3RoaW5nIGJ1dC5cbiAqXG4gKiBQdXJlIGFuZCBsaW5lYXI6IG9uZSBwYXNzIG92ZXIgdGhlIGxpbmVzLCBmaXhlZC1zdHJpbmcgc2VhcmNoZXMsIGFuZCB0d29cbiAqIGFuY2hvcmVkIGhlYWRpbmcgdGVzdHMgcGVyIGhlYWRpbmcgbGluZS5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgeyBSRURBQ1RJT05fUExBQ0VIT0xERVIgfSBmcm9tIFwiLi9zZWNyZXRfcmVkYWN0aW9uLnRzXCI7XG5pbXBvcnQgeyBQUk9NUFRfTEVBS19QTEFDRUhPTERFUiB9IGZyb20gXCIuL3Byb21wdF9sZWFrX3JlZGFjdGlvbi50c1wiO1xuXG4vKiogRXZlcnkgcGxhY2Vob2xkZXIgdGhlIHdvcmtlcidzIG1hc2tzIHN1YnN0aXR1dGUuICovXG5leHBvcnQgY29uc3QgTUFTS19QTEFDRUhPTERFUlM6IHJlYWRvbmx5IHN0cmluZ1tdID0gW1xuICBSRURBQ1RJT05fUExBQ0VIT0xERVIsXG4gIFBST01QVF9MRUFLX1BMQUNFSE9MREVSLFxuXTtcblxuLyoqXG4gKiBIaWRkZW4gbWFya2VyIG9uIHRoZSBjbGFyaWZpY2F0aW9uIGNvbW1lbnQgdGhhdCBhc2tzIGZvciBhIG1hc2tlZCB2YWx1ZSwgc29cbiAqIHRoZSBwaWNrdXAgcGF0aCBjYW4gdGVsbCBpdHMgb3duIHF1ZXN0aW9uIGhhcyBiZWVuIGFuc3dlcmVkLlxuICovXG5leHBvcnQgY29uc3QgTUFTS0VEX0lOU1RSVUNUSU9OX1FVRVNUSU9OX01BUktFUiA9XG4gIFwiPCEtLSBtYXNrZWQtaW5zdHJ1Y3Rpb24tcXVlc3Rpb24gLS0+XCI7XG5cbi8qKiBPbmUgaW5zdHJ1Y3Rpb24gbGluZSBhIG1hc2sgbWFkZSB1bnJlYWRhYmxlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBNYXNrZWRJbnN0cnVjdGlvbiB7XG4gIC8qKiAxLWJhc2VkIGxpbmUgbnVtYmVyIGluIHRoZSBib2R5LiAqL1xuICBsaW5lOiBudW1iZXI7XG4gIC8qKiBIZWFkaW5nIHRoZSBsaW5lIHNpdHMgdW5kZXIsIG9yIGBcIlwiYCBiZWZvcmUgdGhlIGZpcnN0IGhlYWRpbmcuICovXG4gIHNlY3Rpb246IHN0cmluZztcbiAgLyoqIFRoZSBsaW5lLCB0cmltbWVkIGFuZCBib3VuZGVkIGZvciBxdW90aW5nIGJhY2sgdG8gdGhlIGF1dGhvci4gKi9cbiAgdGV4dDogc3RyaW5nO1xufVxuXG4vKiogTG9uZ2VzdCBsaW5lIHF1b3RlZCBiYWNrIGluIGEgcXVlc3Rpb24uICovXG5jb25zdCBNQVhfUVVPVEVEX0NIQVJTID0gMTYwO1xuXG4vKiogTW9zdCBsaW5lcyBuYW1lZCBpbiBvbmUgY2xhcmlmaWNhdGlvbiBjb21tZW50LiAqL1xuY29uc3QgTUFYX1FVRVNUSU9OUyA9IDU7XG5cbi8qKiBCb2RpZXMgbG9uZ2VyIHRoYW4gdGhpcyBhcmUgbm90IHNjYW5uZWQg4oCUIG5vIHJlYWwgaXNzdWUgYXBwcm9hY2hlcyBpdC4gKi9cbmNvbnN0IE1BWF9TQ0FOX0NIQVJTID0gMjYyXzE0NDtcblxuLy8gQSBoZWFkaW5nIHdob3NlIHNlY3Rpb24gaG9sZHMgZXZpZGVuY2U6IG1hc2tpbmcgdGhlcmUgaXMgY29ycmVjdC5cbmNvbnN0IEVWSURFTkNFX0hFQURJTkdfUkUgPVxuICAvXFxiKGV2aWRlbmNlfGxvZ3M/fG91dHB1dHxlcnJvcnM/fHRyYWNlcz98c3RhY2t8dHJhbnNjcmlwdHxvYnNlcnZlZHxhY3R1YWx8d2hhdCBoYXBwZW5lZHx3aHkgdGhpcyBtYXR0ZXJzfGJhY2tncm91bmR8Y29udGV4dHxyZXByb2R1Y1xcdyopXFxiL2k7XG5cbi8vIEEgaGVhZGluZyB3aG9zZSBzZWN0aW9uIGhvbGRzIHRoZSB3b3JrOiBhIGZlbmNlIHRoZXJlIGlzIHBhcnQgb2YgdGhlIGFzay5cbmNvbnN0IElOU1RSVUNUSU9OX0hFQURJTkdfUkUgPVxuICAvXFxiKGZpeHxmaXhlc3xzb2x1dGlvbnxzdGVwcz98dGFza3M/fHRvZG98Y2hhbmdlcz98aW1wbGVtZW50XFx3KnxleHBlY3RlZHxhY2NlcHRhbmNlfGluc3RydWN0aW9ucz98cHJvcG9zYWx8cHJvcG9zZWR8c3VnZ2VzdFxcdyp8cmVxdWlyZW1lbnRzP3xzY29wZXxob3cpXFxiL2k7XG5cbmNvbnN0IEhFQURJTkdfUkUgPSAvXlxcc3swLDN9I3sxLDZ9XFxzKyguKj8pXFxzKiMqXFxzKiQvO1xuY29uc3QgRkVOQ0VfUkUgPSAvXlxcc3swLDN9KGBgYHx+fn4pLztcblxuLyoqIFJlbW92ZSBwbGFjZWhvbGRlcnMgd3JpdHRlbiBhcyBhIHRoaW5nIGluIHRoZWlyIG93biBjb2RlIHNwYW4uICovXG5mdW5jdGlvbiB3aXRob3V0TWVudGlvbnMobGluZTogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IG91dCA9IGxpbmU7XG4gIGZvciAoY29uc3QgcGxhY2Vob2xkZXIgb2YgTUFTS19QTEFDRUhPTERFUlMpIHtcbiAgICBvdXQgPSBvdXQucmVwbGFjZUFsbChgXFxgJHtwbGFjZWhvbGRlcn1cXGBgLCBcIlwiKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vLyBUaGUgc2VjcmV0IHBsYWNlaG9sZGVyIHN0YW5kaW5nIGFzIHRoZSB2YWx1ZSBvZiBhbiBhc3NpZ25tZW50OlxuLy8gYGtleTogKioqUkVEQUNURUQqKipgLCBgS0VZPSoqKlJFREFDVEVEKioqYCwgYFwia2V5XCI6IFwiKioqUkVEQUNURUQqKipcImAuXG5jb25zdCBNQVNLRURfQVNTSUdOTUVOVCA9IG5ldyBSZWdFeHAoXG4gIGBbPTpdXFxcXHN7MCw4fVtcIiddPyR7UkVEQUNUSU9OX1BMQUNFSE9MREVSLnJlcGxhY2VBbGwoXCIqXCIsIFwiXFxcXCpcIil9YCxcbik7XG5cbi8qKlxuICogRG9lcyB0aGlzIGxpbmUgY2FycnkgYSBtYXNrZWQgdmFsdWUgdGhlIHJlYWRlciBuZWVkZWQ/XG4gKlxuICogQSBzZWNyZXQgbWFza2VkIGluIHJ1bm5pbmcgcHJvc2Ug4oCUIFwiZm91bmQgdG9rZW4gKioqUkVEQUNURUQqKiogaW5cbiAqIGNvbmZpZy50cywgcm90YXRlIGl0XCIg4oCUIGlzIG1hc2tpbmcgZG9pbmcgaXRzIGpvYjogbm9ib2R5IG5lZWRzIHRoYXQgdmFsdWUgdG9cbiAqIGFjdC4gVGhlIGluY2lkZW50J3Mgc2hhcGUgaXMgZGlmZmVyZW50OiB0aGUgcGxhY2Vob2xkZXIgaXMgdGhlICoqdmFsdWUgb2YgYW5cbiAqIGFzc2lnbm1lbnQqKiB0aGUgaW5zdHJ1Y3Rpb24gdGVsbHMgdGhlIHJlYWRlciB0byBtYWtlLiBBIHByb21wdC1sZWFrXG4gKiBwbGFjZWhvbGRlciBpcyBhIHdob2xlIHBhc3NhZ2UgcmVtb3ZlZCwgc28gaXQgY291bnRzIHdoZXJldmVyIGl0IGxhbmRzLlxuICovXG5mdW5jdGlvbiBjYXJyaWVzTWFza2VkVmFsdWUobGluZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBsaW5lLmluY2x1ZGVzKFBST01QVF9MRUFLX1BMQUNFSE9MREVSKSB8fFxuICAgIE1BU0tFRF9BU1NJR05NRU5ULnRlc3QobGluZSk7XG59XG5cbi8qKlxuICogRmluZCB0aGUgaW5zdHJ1Y3Rpb24gbGluZXMgb2YgYW4gaXNzdWUgYm9keSB0aGF0IGNhcnJ5IGEgbWFzayBwbGFjZWhvbGRlci5cbiAqXG4gKiBAcGFyYW0gYm9keSAtIFRoZSBpc3N1ZSBib2R5IGFzIHB1Ymxpc2hlZC5cbiAqIEByZXR1cm5zIE9uZSBlbnRyeSBwZXIgdW5yZWFkYWJsZSBpbnN0cnVjdGlvbiBsaW5lLCBpbiBkb2N1bWVudCBvcmRlcjtcbiAqICAgZW1wdHkgd2hlbiB0aGUgYm9keSBpcyB3b3JrYWJsZSAob3IgdG9vIGxhcmdlIHRvIGJlIGEgcmVhbCBpc3N1ZSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBmaW5kTWFza2VkSW5zdHJ1Y3Rpb25zKGJvZHk6IHN0cmluZyk6IE1hc2tlZEluc3RydWN0aW9uW10ge1xuICBpZiAoYm9keS5sZW5ndGggPiBNQVhfU0NBTl9DSEFSUykgcmV0dXJuIFtdO1xuICBpZiAoIU1BU0tfUExBQ0VIT0xERVJTLnNvbWUoKHApID0+IGJvZHkuaW5jbHVkZXMocCkpKSByZXR1cm4gW107XG5cbiAgY29uc3QgaGl0czogTWFza2VkSW5zdHJ1Y3Rpb25bXSA9IFtdO1xuICBsZXQgc2VjdGlvbiA9IFwiXCI7XG4gIGxldCBldmlkZW5jZSA9IGZhbHNlO1xuICBsZXQgaW5zdHJ1Y3Rpb24gPSBmYWxzZTtcbiAgbGV0IGluRmVuY2UgPSBmYWxzZTtcblxuICBjb25zdCBsaW5lcyA9IGJvZHkuc3BsaXQoXCJcXG5cIik7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbGluZXMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBsaW5lID0gbGluZXNbaV0gPz8gXCJcIjtcblxuICAgIGlmIChGRU5DRV9SRS50ZXN0KGxpbmUpKSB7XG4gICAgICBpbkZlbmNlID0gIWluRmVuY2U7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKCFpbkZlbmNlKSB7XG4gICAgICBjb25zdCBoZWFkaW5nID0gSEVBRElOR19SRS5leGVjKGxpbmUpO1xuICAgICAgaWYgKGhlYWRpbmcpIHtcbiAgICAgICAgc2VjdGlvbiA9IChoZWFkaW5nWzFdID8/IFwiXCIpLnRyaW0oKTtcbiAgICAgICAgZXZpZGVuY2UgPSBFVklERU5DRV9IRUFESU5HX1JFLnRlc3Qoc2VjdGlvbik7XG4gICAgICAgIGluc3RydWN0aW9uID0gSU5TVFJVQ1RJT05fSEVBRElOR19SRS50ZXN0KHNlY3Rpb24pO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoZXZpZGVuY2UpIGNvbnRpbnVlO1xuICAgIGlmIChpbkZlbmNlICYmICFpbnN0cnVjdGlvbikgY29udGludWU7XG4gICAgaWYgKCFpbkZlbmNlICYmIGxpbmUudHJpbVN0YXJ0KCkuc3RhcnRzV2l0aChcIj5cIikpIGNvbnRpbnVlO1xuXG4gICAgaWYgKCFjYXJyaWVzTWFza2VkVmFsdWUod2l0aG91dE1lbnRpb25zKGxpbmUpKSkgY29udGludWU7XG5cbiAgICBoaXRzLnB1c2goe1xuICAgICAgbGluZTogaSArIDEsXG4gICAgICBzZWN0aW9uLFxuICAgICAgdGV4dDogbGluZS50cmltKCkuc2xpY2UoMCwgTUFYX1FVT1RFRF9DSEFSUyksXG4gICAgfSk7XG4gIH1cbiAgcmV0dXJuIGhpdHM7XG59XG5cbi8qKlxuICogVGhlIHF1ZXN0aW9ucyBwb3N0ZWQgdGhyb3VnaCB0aGUgY2xhcmlmaWNhdGlvbiByb3V0ZSBmb3IgbWFza2VkIGxpbmVzLlxuICpcbiAqIEV2ZXJ5IHF1b3RlZCBsaW5lIGFscmVhZHkgY2FycmllcyB0aGUgcGxhY2Vob2xkZXIsIG5ldmVyIHRoZSB2YWx1ZSwgc28gdGhlXG4gKiB0ZXh0IGlzIHNhZmUgdG8gcHVibGlzaDsgaXQgc3RpbGwgcGFzc2VzIHRocm91Z2ggdGhlIGNsYXJpZmljYXRpb24gcm91dGUnc1xuICogb3duIGByZWRhY3RTZWNyZXRzYCBsaWtlIGFueSBvdGhlciBxdWVzdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkTWFza2VkSW5zdHJ1Y3Rpb25RdWVzdGlvbnMoXG4gIGhpdHM6IHJlYWRvbmx5IE1hc2tlZEluc3RydWN0aW9uW10sXG4pOiBzdHJpbmcge1xuICBjb25zdCBzaG93biA9IGhpdHMuc2xpY2UoMCwgTUFYX1FVRVNUSU9OUyk7XG4gIGNvbnN0IGxpbmVzID0gc2hvd24ubWFwKChoLCBuKSA9PiB7XG4gICAgY29uc3Qgd2hlcmUgPSBoLnNlY3Rpb24gPyBgIHVuZGVyICoqJHtoLnNlY3Rpb259KipgIDogXCJcIjtcbiAgICByZXR1cm4gYCR7biArIDF9LiBPbiBsaW5lICR7aC5saW5lfSR7d2hlcmV9LCBhIHZhbHVlIHdhcyBtYXNrZWQgYmVmb3JlIGAgK1xuICAgICAgYHRoaXMgaXNzdWUgd2FzIHB1Ymxpc2hlZCwgc28gdGhlIGluc3RydWN0aW9uIGNhbm5vdCBiZSBmb2xsb3dlZDpcXG5cXG5gICtcbiAgICAgIGAgICA+ICR7aC50ZXh0LnJlcGxhY2VBbGwoXCJgXCIsIFwiJ1wiKX1cXG5cXG5gICtcbiAgICAgIGAgICBXaGF0IHNob3VsZCBpdCBzYXk/YDtcbiAgfSk7XG4gIGNvbnN0IG1vcmUgPSBoaXRzLmxlbmd0aCA+IHNob3duLmxlbmd0aFxuICAgID8gYFxcblxcbuKApmFuZCAke2hpdHMubGVuZ3RoIC0gc2hvd24ubGVuZ3RofSBtb3JlIG1hc2tlZCBsaW5lKHMpLmBcbiAgICA6IFwiXCI7XG4gIHJldHVybiBsaW5lcy5qb2luKFwiXFxuXFxuXCIpICsgbW9yZSArIFwiXFxuXFxuXCIgK1xuICAgIFwiUGxlYXNlICoqZWRpdCB0aGUgaXNzdWUqKiB0ZXh0IHRvIHJlc3RvcmUgdGhlIHZhbHVlIOKAlCB0aGF0IGlzIHdoYXQgdGhlIFwiICtcbiAgICBcIndvcmtlciByZWFkcy4gSWYgdGhlIG1hc2tlZCB2YWx1ZSBpcyBhICoqcmVhbCBzZWNyZXQqKiwgZG8gbm90IHBhc3RlIFwiICtcbiAgICBcIml0OiBkZXNjcmliZSB0aGUgY2hhbmdlIHdpdGhvdXQgaXQgKG5hbWUgdGhlIHNldHRpbmcgb3IgdGhlIHNlY3JldCdzIFwiICtcbiAgICBcInN0b3JlLCBub3QgaXRzIHZhbHVlKS5cIjtcbn1cblxuLyoqIE5vdGljZSBhcHBlbmRlZCB0byBhIHdvcmtlci1hdXRob3JlZCBpc3N1ZSBmaWxlZCB3aXRoIGEgbWFza2VkIGluc3RydWN0aW9uLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkTWFza2VkSW5zdHJ1Y3Rpb25Ob3RpY2UoXG4gIGhpdHM6IHJlYWRvbmx5IE1hc2tlZEluc3RydWN0aW9uW10sXG4pOiBzdHJpbmcge1xuICBjb25zdCB3aGVyZSA9IGhpdHMuc2xpY2UoMCwgTUFYX1FVRVNUSU9OUykubWFwKChoKSA9PiBgbGluZSAke2gubGluZX1gKVxuICAgIC5qb2luKFwiLCBcIik7XG4gIHJldHVybiBcIlxcblxcbi0tLVxcblwiICtcbiAgICBcIuKaoO+4jyAqKkEgdmFsdWUgaW4gdGhpcyBpc3N1ZSdzIGluc3RydWN0aW9ucyB3YXMgbWFza2VkIGJ5IHRoZSB3b3JrZXIncyBcIiArXG4gICAgYHNlY3JldCBmaWx0ZXIgYmVmb3JlIGl0IHdhcyBwdWJsaXNoZWQqKiAoJHt3aGVyZX0pLiBJZiB0aGUgdmFsdWUgaXMgbm90IGAgK1xuICAgIFwiYSBzZWNyZXQgdGhpcyBpcyBhIGZhbHNlIHBvc2l0aXZlIGluIHRoZSBmaWx0ZXI6IHJlc3RvcmUgaXQgYnkgZWRpdGluZyBcIiArXG4gICAgXCJ0aGlzIGlzc3VlLiBUaGUgd29ya2VyIHdpbGwgYXNrIGZvciBpdCBiZWZvcmUgd29ya2luZyB0aGlzIGlzc3VlIFwiICtcbiAgICBcInJhdGhlciB0aGFuIGd1ZXNzLlwiO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0E2Q0MsR0FFRCxTQUFTLHFCQUFxQixRQUFRLHdCQUF3QjtBQUM5RCxTQUFTLHVCQUF1QixRQUFRLDZCQUE2QjtBQUVyRSxxREFBcUQsR0FDckQsT0FBTyxNQUFNLG9CQUF1QztFQUNsRDtFQUNBO0NBQ0QsQ0FBQztBQUVGOzs7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
// denoCacheMetadata=11061669317294349771,192319070364144837