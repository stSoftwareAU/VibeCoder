/**
 * Grill-me stop rule: stall guard plus runaway ceiling (Issue #1933).
 *
 * A fixed round cap halted a productive grilling: on stSoftwareAU/GRQ#4754 the
 * developer answered five rounds in 2.5 hours, every round asked questions not
 * asked before, and the worker escalated the moment the count reached
 * `maxGrillMeRounds`. Productivity — not a counter — now decides when grilling
 * stops:
 *
 *   - **Stall guard.** A round is stalled when every one of its numbered
 *     question stems, after normalisation, already appeared in an earlier
 *     round of the same grilling. One stalled round trips the guard; a round
 *     with at least one new stem never does.
 *   - **Runaway ceiling.** `maxGrillMeRounds` becomes the ceiling: when the
 *     next round would be the ceiling-th round of this grilling, that round is
 *     the forced final one, so a grilling posts at most `maxGrillMeRounds`
 *     rounds since its latest Ready comment.
 *
 * When either trips, the next round is a **forced final round**: the prompt is
 * told it must post the Ready comment and record each still-open question as a
 * named assumption. Only a forced final round that fails to post Ready
 * escalates to `needs-human`.
 *
 * Every function here is pure — the processor owns the comment window (the
 * rounds posted since the latest Ready comment) and the GitHub side effects.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/** Why the next grill-me round is a forced final round. */
export type GrillMeStopTrigger =
  | {
    kind: "stall";
    /** Issue-wide heading number of the round that repeated every stem. */
    roundNumber: number;
  }
  | {
    kind: "ceiling";
    /** The configured runaway ceiling (`maxGrillMeRounds`). */
    ceiling: number;
  };

/** Heading that opens the question list of a round comment. */
const QUESTIONS_HEADING = /^#{2,6}\s+questions\b/i;

/** Any Markdown heading — ends the question list. */
const ANY_HEADING = /^#{1,6}\s/;

/** A numbered question stem, e.g. `1. What is the stop rule?`. */
const NUMBERED_STEM = /^\s*\d+\.\s+(\S.*)$/;

/**
 * Read the numbered question stems of one round comment.
 *
 * A stem is the text of an `N.` line inside the round's `### Questions`
 * section; the checkbox option rows beneath it (`- [ ] …`) are not stems, and
 * numbered lines outside the section (a numbered list in the Understanding,
 * say) are ignored. A comment with no such section yields none, which is what
 * makes an unparseable round incapable of tripping the stall guard.
 *
 * @param body - Round comment body
 * @returns The raw stem texts, in the order posted
 */
export function parseQuestionStems(body: string): string[] {
  const stems: string[] = [];
  let inQuestions = false;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (ANY_HEADING.test(line)) {
      inQuestions = QUESTIONS_HEADING.test(line);
      continue;
    }
    if (!inQuestions) continue;
    const match = line.match(NUMBERED_STEM);
    if (match) stems.push(match[1]!.trim());
  }
  return stems;
}

/**
 * Normalise a question stem for exact comparison (Issue #1933).
 *
 * Lower-case, strip Markdown emphasis markers (`*`, `_`, backticks), collapse
 * runs of whitespace to one space, then strip trailing punctuation. Comparison
 * is exact equality afterwards — deliberately no similarity threshold, so a
 * genuinely reworded question still counts as new and the grilling continues.
 *
 * @param stem - Raw stem text
 * @returns The normalised form used for comparison
 */
export function normaliseQuestionStem(stem: string): string {
  return stem
    .toLowerCase()
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.,;:!?…—–\s]+$/u, "")
    .trim();
}

/** Normalised stems of one round, with empties dropped. */
function normalisedStems(body: string): string[] {
  return parseQuestionStems(body)
    .map(normaliseQuestionStem)
    .filter((stem) => stem.length > 0);
}

/**
 * Is the most recently posted round stalled?
 *
 * True only when the latest round has at least one parseable stem and every
 * one of them already appeared in an earlier round of the same grilling. Only
 * the latest round is tested — each earlier round was tested while it was the
 * latest, so a grilling that recovered with a fresh question is productive
 * again.
 *
 * @param roundBodies - Round comment bodies of this grilling, oldest first
 */
export function isRoundStalled(roundBodies: readonly string[]): boolean {
  if (roundBodies.length < 2) return false;
  const latest = normalisedStems(roundBodies[roundBodies.length - 1]!);
  if (latest.length === 0) return false;
  const earlier = new Set<string>();
  for (let i = 0; i < roundBodies.length - 1; i++) {
    for (const stem of normalisedStems(roundBodies[i]!)) earlier.add(stem);
  }
  return latest.every((stem) => earlier.has(stem));
}

/**
 * Decide whether the next grill-me round must be a forced final round.
 *
 * @param opts.roundBodies - Round comment bodies of this grilling, oldest first
 * @param opts.latestRoundNumber - Issue-wide heading number of the newest round
 * @param opts.maxRounds - Runaway ceiling (`maxGrillMeRounds`)
 * @returns The trigger, or `null` when the next round is an ordinary one
 */
export function decideGrillMeStop(opts: {
  roundBodies: readonly string[];
  latestRoundNumber: number;
  maxRounds: number;
}): GrillMeStopTrigger | null {
  if (isRoundStalled(opts.roundBodies)) {
    return { kind: "stall", roundNumber: opts.latestRoundNumber };
  }
  // The ceiling-th round is itself the forced final round, so a grilling never
  // posts more than `maxRounds` rounds since its latest Ready comment.
  if (opts.roundBodies.length + 1 >= opts.maxRounds) {
    return { kind: "ceiling", ceiling: opts.maxRounds };
  }
  return null;
}

/**
 * The one line a forced final round's Ready comment carries directly under its
 * TL;DR, naming what forced it. The same line names the trigger in the
 * escalation comment when a forced round fails to post Ready.
 *
 * @param trigger - What forced the round
 */
export function forcedFinalTriggerLine(trigger: GrillMeStopTrigger): string {
  return trigger.kind === "stall"
    ? `Forced final round: stall guard tripped at Round ${trigger.roundNumber}`
    : `Forced final round: round ceiling (${trigger.ceiling}) reached`;
}
