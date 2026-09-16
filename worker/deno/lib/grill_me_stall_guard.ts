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
 * The two read **different inputs**, and Issue #2237 is why the distinction is
 * structural rather than a convention. Round comments are selected by heading
 * marker with no author check (`carriesRoundMarker` in
 * `grill_me_processor.ts`, deliberately so since #1560 and #3768), so any
 * account that can comment on the issue can post a `## Grill-Me Round N`
 * comment. Inflating the author-agnostic **count** is harmless — it only
 * brings the converging ceiling closer — but the stall guard *acts* on the
 * stems it reads, so one forged comment repeating the worker's own published
 * questions ended the clarification loop early. {@link decideGrillMeStop}
 * therefore takes the stall input and the ceiling input as two separate
 * parameters: `fleetRoundBodies` (author-verified) and `roundCount`
 * (author-agnostic). A caller cannot satisfy one with the other by accident.
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
 * Trailing characters a question stem is compared without: sentence
 * punctuation and whitespace.
 */
const TRAILING_STEM_CHARS = new Set([
  ".",
  ",",
  ";",
  ":",
  "!",
  "?",
  "\u2026", // …
  "\u2014", // —
  "\u2013", // –
  " ",
  "\t",
  "\n",
  "\r",
  "\f",
  "\v",
  "\u00a0",
]);

/**
 * Strip {@link TRAILING_STEM_CHARS} from the end of a stem, in one backward
 * walk (Issue #2183).
 *
 * This was `replace(/[.,;:!?…—–\s]+$/u, "")`, and that is quadratic: the
 * regex is unanchored, so the engine retries the match at every start offset
 * and each retry rescans the whole run before failing at `$`. Round comments
 * are collected by heading marker with **no author gate** (`carriesRoundMarker`
 * in `grill_me_processor.ts`, deliberately so since Issue #1560), so any
 * commenter could hand the guard a 65 536-character stem ending in one
 * non-punctuation character and spend seconds of worker CPU per pass. The
 * delta sweep of ledger slices 12d–12f measured 43 ms at 10 000 characters
 * against 695 ms at 40 000 — a 4x input costing 16x.
 *
 * The walk visits each trailing character once and stops at the first
 * character that is not stripped, so the cost is linear in the length of the
 * run. The result matches the regex for every input this function can
 * receive: `\s` also covers exotic Unicode spaces the set omits, but the
 * caller has already collapsed whitespace to a single U+0020 before the
 * strip, so none of them can reach it.
 *
 * @param text - Stem text, already lower-cased and whitespace-collapsed
 * @returns The text without its trailing punctuation and whitespace
 */
function stripTrailingPunctuation(text: string): string {
  let end = text.length;
  while (end > 0 && TRAILING_STEM_CHARS.has(text[end - 1]!)) end--;
  return text.slice(0, end);
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
  return stripTrailingPunctuation(
    stem
      .toLowerCase()
      .replace(/[*_`]/g, "")
      .replace(/\s+/g, " ")
      .trim(),
  ).trim();
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
 * Callers pass **fleet-authored** bodies only: this function decides that the
 * grilling must stop asking, so a body written by anyone who can comment on
 * the issue is not evidence it may act on (Issue #2237).
 *
 * @param roundBodies - Fleet-authored round comment bodies of this grilling,
 *   oldest first
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
 * The two inputs are deliberately separate — see the module comment. Passing
 * the author-agnostic bodies as `fleetRoundBodies` reopens Issue #2237;
 * passing only the fleet-authored count as `roundCount` regresses #1560 and
 * #3768 by letting a peer identity's rounds escape the ceiling.
 *
 * @param opts.fleetRoundBodies - Bodies of this grilling's rounds that a
 *   **fleet** account authored, oldest first. The stall guard's only input,
 *   because it acts on what it reads (Issue #2237).
 * @param opts.roundCount - How many rounds this grilling has posted, counted
 *   **author-agnostically**. The runaway ceiling's only input (#1560, #3768).
 * @param opts.latestRoundNumber - Issue-wide heading number of the newest round
 * @param opts.maxRounds - Runaway ceiling (`maxGrillMeRounds`)
 * @returns The trigger, or `null` when the next round is an ordinary one
 */
export function decideGrillMeStop(opts: {
  fleetRoundBodies: readonly string[];
  roundCount: number;
  latestRoundNumber: number;
  maxRounds: number;
}): GrillMeStopTrigger | null {
  if (isRoundStalled(opts.fleetRoundBodies)) {
    return { kind: "stall", roundNumber: opts.latestRoundNumber };
  }
  // The ceiling-th round is itself the forced final round, so a grilling never
  // posts more than `maxRounds` rounds since its latest Ready comment. This
  // count stays author-agnostic (#1560, #3768): a forged round can only bring
  // the ceiling closer, and the ceiling round converges.
  if (opts.roundCount + 1 >= opts.maxRounds) {
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
