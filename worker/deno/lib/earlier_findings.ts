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

/** The code owes a blocking finding for each missing, duplicate or unresolved verdict. */
export function earlierFindingGaps(
  expected: readonly string[],
  verdicts: readonly EarlierVerdict[],
): { file: string; line: number; problem: string; fix: string }[] {
  return expected.flatMap((finding, offset) => {
    const index = offset + 1;
    const matches = verdicts.filter((v) => v.index === index);
    if (matches.length === 1 && matches[0]!.verdict === "fixed") return [];
    return [{
      file: "(earlier review)",
      line: 0,
      problem:
        `Earlier finding ${index} is not independently verified as fixed: ${finding}`,
      fix:
        `Resolve every ask and supply exactly one evidenced fixed verdict for index ${index}.`,
    }];
  });
}
