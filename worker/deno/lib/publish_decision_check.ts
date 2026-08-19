/**
 * Publish-decision dossier checker (Issue #4200).
 *
 * Phase 4 of plan #4160 is a go/no-go whose default is "stay private". The
 * dossier `docs/PUBLISH-DECISION.md` records the five conditions with
 * evidence rather than intention. This checker makes an incomplete dossier
 * unable to read as a GO:
 *
 * - every one of the five condition sections must exist,
 * - each must carry a `**Verdict:** MET|UNMET` line,
 * - each must cite at least one repository artefact (a backticked path) in
 *   its `**Evidence:**` field — a verdict by assertion alone is a problem,
 * - the document must end with a dated `**Verdict: GO|NO-GO**` line,
 * - `GO` is only valid when every condition is MET.
 *
 * Pure text in, structured result out — no I/O — so the command and the
 * tests share one implementation.
 *
 * Uses Australian English throughout (behaviour, organisation, artefact).
 */

/** The five "what convinced looks like" conditions of Phase 4. */
export const PHASE4_CONDITION_COUNT = 5;

export type ConditionVerdict = "MET" | "UNMET";

export interface ConditionCheck {
  /** 1-based condition number as written in the heading. */
  number: number;
  /** Heading text after the number. */
  title: string;
  /** Parsed verdict, or null when the section has none. */
  verdict: ConditionVerdict | null;
  /** Backticked repository paths cited in the Evidence field. */
  evidencePaths: string[];
}

export interface PublishDecisionCheck {
  conditions: ConditionCheck[];
  /** Document verdict, or null when the verdict line is missing. */
  verdict: "GO" | "NO-GO" | null;
  /** ISO date from the verdict line, or null when undated. */
  dated: string | null;
  /** Human-readable problems; empty means the dossier is well-formed. */
  problems: string[];
}

const CONDITION_HEADING_RE = /^###\s+Condition\s+(\d+)\s*[—–-]\s*(.+?)\s*$/gm;
const CONDITION_VERDICT_RE = /\*\*Verdict:\*\*\s*(MET|UNMET)\b/;
const DOCUMENT_VERDICT_RE =
  /\*\*Verdict:\s*(GO|NO-GO)\*\*(?:\s*[—–-]\s*dated\s+(\d{4}-\d{2}-\d{2}))?/;
const EVIDENCE_FIELD_RE =
  /\*\*Evidence:\*\*([\s\S]*?)(?=\n\*\*[A-Z][a-z-]+:\*\*|\n#{1,6}\s|$)/;
const BACKTICKED_PATH_RE =
  /`([^`\s]+\/[^`\s]*|[A-Z][A-Z0-9_.-]*\.md|LICENSE)`/g;

/** Split the dossier into condition sections keyed by heading. */
function conditionSections(
  text: string,
): Array<{ number: number; title: string; body: string }> {
  const matches = [...text.matchAll(CONDITION_HEADING_RE)];
  return matches.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length;
    const next = matches[i + 1];
    const end = next?.index ?? text.length;
    // A section ends at the next heading of any level, whichever comes first.
    const body = text.slice(start, end);
    const nextHeading = body.search(/\n#{1,3}\s/);
    return {
      number: Number(m[1]),
      title: m[2] ?? "",
      body: nextHeading === -1 ? body : body.slice(0, nextHeading),
    };
  });
}

/** Extract cited repository paths from a section's Evidence field. */
function evidencePathsOf(body: string): string[] {
  const field = EVIDENCE_FIELD_RE.exec(body)?.[1];
  if (field === undefined) return [];
  return [...field.matchAll(BACKTICKED_PATH_RE)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]]
  );
}

/** Parse and check the dossier text. Never throws on malformed input. */
export function checkPublishDecision(text: string): PublishDecisionCheck {
  const problems: string[] = [];
  const parsed = conditionSections(text);
  const conditions: ConditionCheck[] = [];

  for (let n = 1; n <= PHASE4_CONDITION_COUNT; n++) {
    const section = parsed.find((s) => s.number === n);
    if (!section) {
      problems.push(`Condition ${n} section is missing`);
      continue;
    }
    const verdictMatch = CONDITION_VERDICT_RE.exec(section.body);
    const verdict = verdictMatch ? (verdictMatch[1] as ConditionVerdict) : null;
    const evidencePaths = evidencePathsOf(section.body);
    if (!verdict) {
      problems.push(
        `Condition ${n} has no verdict (expected "**Verdict:** MET" or "**Verdict:** UNMET")`,
      );
    }
    if (evidencePaths.length === 0) {
      problems.push(
        `Condition ${n} cites no artefact in its Evidence field — a verdict by assertion alone does not count`,
      );
    }
    conditions.push({
      number: n,
      title: section.title,
      verdict,
      evidencePaths,
    });
  }

  const extra = parsed.filter((s) =>
    s.number < 1 || s.number > PHASE4_CONDITION_COUNT
  );
  for (const s of extra) {
    problems.push(
      `Condition ${s.number} is outside the five Phase 4 conditions`,
    );
  }

  const verdictMatch = DOCUMENT_VERDICT_RE.exec(text);
  const verdict = verdictMatch ? (verdictMatch[1] as "GO" | "NO-GO") : null;
  const dated = verdictMatch?.[2] ?? null;
  if (!verdict) {
    problems.push(
      'The document verdict line is missing (expected "**Verdict: GO**" or "**Verdict: NO-GO**")',
    );
  } else if (!dated) {
    problems.push(
      "The document verdict line is not dated (— dated YYYY-MM-DD)",
    );
  }

  if (verdict === "GO") {
    const notMet = conditions.filter((c) => c.verdict !== "MET");
    const missing = [1, 2, 3, 4, 5].filter((n) =>
      !conditions.some((c) => c.number === n)
    );
    const names = [
      ...notMet.map((c) => `Condition ${c.number}`),
      ...missing.map((n) => `Condition ${n}`),
    ];
    if (names.length > 0) {
      problems.push(
        `Verdict is GO but not every condition is MET with evidence: ${
          names.join(", ")
        }`,
      );
    }
    for (const c of conditions) {
      if (c.verdict === "MET" && c.evidencePaths.length === 0) {
        problems.push(
          `Condition ${c.number} is MET without a cited artefact — GO is not permitted on assertion`,
        );
      }
    }
  }

  return { conditions, verdict, dated, problems };
}

/** Convenience: only the problems. */
export function publishDecisionProblems(text: string): string[] {
  return checkPublishDecision(text).problems;
}
