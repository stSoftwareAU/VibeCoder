/**
 * Independent check of closure entries marked `met` (Issue #3766).
 *
 * The agent's own `met` in the PR summary's `## Acceptance Criteria` block was
 * never checked by anything independent. The pre-PR verifier is handed each
 * `met` entry and owes a verdict on it; this module (code, not the model)
 * turns a `partial` or `missing` verdict, or a missing verdict, into a
 * blocking finding. "No verdict" is never a pass.
 *
 * @module
 */

import { parseClosureEntries } from "./acceptance_criteria_gate.ts";
import { subjectOf } from "./closure_criterion_match.ts";
import { gapText, normaliseVerdictText } from "./review_checklists.ts";

/** A closure entry marked `met`, as the verifier is asked to judge it. */
export interface MetClosureItem {
  criterion: string;
}
export type ClosureEntryVerdictValue = "met" | "partial" | "missing";
export interface ClosureEntryVerdict {
  criterion: string;
  verdict: ClosureEntryVerdictValue;
  note: string;
}
/** A blocking finding the worker adds itself. */
export interface ClosureGapFinding {
  file: string;
  line: number;
  problem: string;
  fix: string;
}

/** Longest criterion text carried into the brief or a finding. */
export const CLOSURE_CRITERION_MAX = 500;

const MAX_NOTE = 500;
const MAX_NAMED = 5;
const VERDICTS: readonly string[] = ["met", "partial", "missing"];

function isSeparator(ch: string): boolean {
  return ch === "—" || ch === "–" || ch === "-" || ch === ":" ||
    ch.trim() === "";
}

/** Drop trailing separators with a single backwards scan (linear). */
function stripTrailingSeparators(text: string): string {
  let end = text.length;
  while (end > 0 && isSeparator(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

/** The criteria the summary's closure block marks `met`, bounded and unique. */
export function metClosureItems(summary: string): MetClosureItem[] {
  const seen = new Set<string>();
  const out: MetClosureItem[] = [];
  for (const entry of parseClosureEntries(summary)) {
    if (entry.status !== "met") continue;
    const subject = stripTrailingSeparators(subjectOf(entry));
    const criterion = gapText(
      subject === "" ? entry.text : subject,
      CLOSURE_CRITERION_MAX,
    );
    const key = normaliseVerdictText(criterion);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ criterion });
  }
  return out;
}

/** Markdown the review brief embeds; "" when no entry is marked `met`. */
export function renderClosureEntriesSection(
  items: readonly MetClosureItem[],
): string {
  if (items.length === 0) return "";
  return [
    "### Closure entries marked `met`",
    "",
    `The PR description's \`## Acceptance Criteria\` block marks these ${items.length} entries \`met\`. Judge each one on its own against the change at the head and report EVERY entry below in the reply \`closure\` array with a verdict of \`met\`, \`partial\` or \`missing\` and a note, copying the criterion text exactly as written here. Any entry that is \`partial\` or \`missing\` also needs a blocking entry in \`findings\`. The worker checks that every entry got a verdict; an entry with none, or one rated \`partial\` or \`missing\`, sends the change back.`,
    "",
    ...items.map((item, i) => `${i + 1}. ${item.criterion}`),
  ].join("\n");
}

/** Validate the reply's `closure` array; throws naming the problem. */
export function parseClosureEntryVerdicts(
  value: unknown,
): ClosureEntryVerdict[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("review JSON closure is not an array");
  }
  return value.map((raw: unknown, i: number) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`review JSON closure[${i}] is not an object`);
    }
    const r = raw as Record<string, unknown>;
    if (typeof r.criterion !== "string" || r.criterion.trim() === "") {
      throw new Error(
        `review JSON closure[${i}] lacks a non-empty "criterion"`,
      );
    }
    if (typeof r.verdict !== "string" || !VERDICTS.includes(r.verdict)) {
      throw new Error(
        `review JSON closure[${i}] has verdict=${
          JSON.stringify(r.verdict)
        }; expected met, partial or missing`,
      );
    }
    if (r.note !== undefined && typeof r.note !== "string") {
      throw new Error(`review JSON closure[${i}] has a non-string note`);
    }
    return {
      criterion: r.criterion,
      verdict: r.verdict as ClosureEntryVerdictValue,
      note: (r.note as string | undefined) ?? "",
    };
  });
}

const keyOf = (text: string): string =>
  normaliseVerdictText(gapText(text, CLOSURE_CRITERION_MAX));

/**
 * Blocking findings for `met` entries the verifier rated short or left
 * without a verdict. Verdicts naming no listed item are ignored.
 */
export function closureGapFindings(
  items: readonly MetClosureItem[],
  verdicts: readonly ClosureEntryVerdict[],
  summaryPath: string,
): ClosureGapFinding[] {
  const byKey = new Map<string, ClosureEntryVerdict[]>();
  for (const v of verdicts) {
    const key = keyOf(v.criterion);
    const list = byKey.get(key);
    if (list) list.push(v);
    else byKey.set(key, [v]);
  }
  const out: ClosureGapFinding[] = [];
  const unreported: MetClosureItem[] = [];
  for (const item of items) {
    const matching = byKey.get(keyOf(item.criterion));
    if (!matching || matching.length === 0) {
      unreported.push(item);
      continue;
    }
    const worst = matching.find((v) => v.verdict === "missing") ??
      matching.find((v) => v.verdict === "partial");
    if (!worst) continue;
    const note = worst.note.trim();
    out.push({
      file: summaryPath,
      line: 0,
      problem:
        `Closure entry marked met was rated ${worst.verdict} by the pre-PR verifier: "${item.criterion}"${
          note ? ` — ${gapText(note, MAX_NOTE)}` : ""
        }`,
      fix:
        "Deliver every case, path and test the criterion names in the code and its tests, or mark the entry `partial` (or `missing`) with a `reason:` saying what is left out.",
    });
  }
  if (unreported.length > 0) {
    const named = unreported.slice(0, MAX_NAMED).map((u) => `"${u.criterion}"`)
      .join("; ");
    const more = unreported.length > MAX_NAMED
      ? `; and ${unreported.length - MAX_NAMED} more`
      : "";
    out.push({
      file: summaryPath,
      line: 0,
      problem:
        `No verdict was reported for ${unreported.length} of ${items.length} closure ${
          items.length === 1 ? "entry" : "entries"
        } marked met, so they were not checked: ${named}${more}`,
      fix:
        "Report each listed closure entry in the `closure` array as met, partial or missing, with the criterion text as listed.",
    });
  }
  return out;
}
