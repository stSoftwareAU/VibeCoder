/** Per-finding review-fix evidence shared by the worker and fleet reviewer (#3784). */
export interface EarlierVerdict {
  index: number;
  verdict: "fixed" | "partly" | "not fixed";
  note: string;
}

/** Preserve complete problem/Fix pairs; unfamiliar review formats stay whole. */
export function extractEarlierFindings(body: string): string[] {
  const findings: string[] = [];
  let lines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\*\*`[^`]+`\*\*:/.test(line) && lines.length > 0) {
      const text = lines.join("\n").trim();
      if (text) findings.push(text);
      lines = [];
    }
    lines.push(line);
  }
  const text = lines.join("\n").trim();
  if (text) findings.push(text);
  return findings;
}

/** Missing arrays are empty so the expectation check reports each omitted item. */
export function parseEarlierVerdicts(raw: unknown): EarlierVerdict[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("earlierFindings must be an array");
  return raw.map((v) => {
    if (
      !v || !Number.isInteger(v.index) || v.index < 1 ||
      !["fixed", "partly", "not fixed"].includes(v.verdict) ||
      typeof v.note !== "string" || v.note.trim() === ""
    ) throw new Error("invalid earlierFindings verdict");
    return { index: v.index, verdict: v.verdict, note: v.note };
  });
}

/** An earlier finding as the fleet log stores it; a gap also carries the finding it wraps. */
export interface EarlierFinding {
  file: string;
  line: number;
  problem: string;
  fix?: string;
  earlier?: EarlierFinding;
}

/** Opens the original finding inside a gap's text, so a gap quoted as text can be unwrapped. */
const ORIGINAL_MARKER = "Original finding: ";
const GAP_FILE = "(earlier review)";
const TEXT_GAP_FIX =
  "Resolve every ask in the original finding, including its Fix, in this change.";
const TEXT_GAP_FIX_TAIL = `\n\n**Fix:** ${TEXT_GAP_FIX}`;

/** The reviewer's verdict for this index, in words; no verdict and a duplicate are named too. */
function verdictText(matches: readonly EarlierVerdict[]): string {
  if (matches.length === 0) return "the reviewer returned no verdict for it";
  if (matches.length > 1) {
    return "the reviewer returned more than one verdict for it";
  }
  const v = matches[0]!;
  return `the reviewer's verdict is ${v.verdict}: ${v.note.trim()}`;
}

/**
 * A gap's own worker-written opening: bare (as this module writes `problem`)
 * or under the `(earlier review)` header a posted review gives it. Only a text
 * that starts this way is a gap; any other finding, or a review summary, that
 * merely quotes the marker is an original and stays whole (PR #4467 review).
 */
const GAP_TEXT_HEAD =
  /^(?:\*\*`\(earlier review\)`\*\*: )?Earlier finding \d+ is not independently verified as fixed \(/;
/** Closes the verdict in a gap's head and opens the quoted original. */
const GAP_TEXT_QUOTE = `). ${ORIGINAL_MARKER}`;

/** A gap carries the finding it wraps, never the wrapper, so it stays one level deep. */
function originalOf(finding: string | EarlierFinding): string | EarlierFinding {
  if (typeof finding === "string") {
    const head = GAP_TEXT_HEAD.exec(finding);
    if (!head) return finding;
    // The first quote opening after the head: an original that itself quotes
    // the marker is kept whole rather than cut at its own copy.
    const at = finding.indexOf(GAP_TEXT_QUOTE, head[0].length);
    if (at < 0) return finding;
    const quoted = finding.slice(at + GAP_TEXT_QUOTE.length);
    // A posted gap ends with its own generic Fix, then (as the last finding)
    // the review summary; reusing either would grow one per round.
    const tail = quoted.indexOf(TEXT_GAP_FIX_TAIL);
    return tail < 0 ? quoted : quoted.slice(0, tail);
  }
  return finding.file === GAP_FILE && finding.earlier
    ? originalOf(finding.earlier)
    : finding;
}

/**
 * The code owes a blocking finding for each missing, duplicate or unresolved
 * verdict. The finding names the reviewer's verdict and note and quotes the
 * original finding as text (`file:line`, problem), with the original Fix
 * addressed to the fleet; the original also rides along as `earlier` data so
 * the next round unwraps it instead of nesting another layer (#4446).
 * `expected` entries are structured findings (fleet log) or the text of a
 * posted finding (the worker's PR-feedback path).
 */
export function earlierFindingGaps(
  expected: readonly (string | EarlierFinding)[],
  verdicts: readonly EarlierVerdict[],
): {
  file: string;
  line: number;
  problem: string;
  fix: string;
  earlier?: EarlierFinding;
}[] {
  return expected.flatMap((wrapped, offset) => {
    const index = offset + 1;
    const matches = verdicts.filter((v) => v.index === index);
    if (matches.length === 1 && matches[0]!.verdict === "fixed") return [];
    const original = originalOf(wrapped);
    const head =
      `Earlier finding ${index} is not independently verified as fixed (${
        verdictText(matches)
      }). ${ORIGINAL_MARKER}`;
    if (typeof original === "string") {
      return [{
        file: GAP_FILE,
        line: 0,
        problem: `${head}${original}`,
        fix: TEXT_GAP_FIX,
      }];
    }
    const at = original.line > 0
      ? `${original.file}:${original.line}`
      : original.file;
    return [{
      file: GAP_FILE,
      line: 0,
      problem: `${head}${at} — ${original.problem}`,
      fix: original.fix?.trim() ||
        "Resolve every ask in the original finding in this change.",
      earlier: original,
    }];
  });
}
