/**
 * The wind-down notice (Issue #508).
 *
 * The run hard cap (Issue #421) is real and stays: what #508 changes is that
 * an agent should meet it deliberately rather than be SIGKILLed mid-poll with
 * no account of what it was waiting for. When the run comes within
 * {@link DEFAULT_WIND_DOWN_SECONDS} of the ceiling the worker writes this
 * notice into the agent's checkout and refreshes it on every later check, so
 * an agent supervising a long job can read the remaining budget, stop
 * waiting, and leave a resumable note beside the WIP the #4170 checkpoints
 * already preserve.
 *
 * The file is the only channel there is: the agent's stdin carries the prompt
 * and is closed at EOF, so nothing can be pushed into a live session. The
 * agent is told the file exists by {@link WIND_DOWN_PROMPT_SECTION}, which
 * rides in the issue prompt.
 *
 * The name is deliberately hidden: `gitignore_enforcer.ts` ignores every
 * hidden path in a monitored repo, so worker state written into the checkout
 * can never reach a commit — and, because `git status` does not report
 * ignored paths, writing it cannot move the working-tree progress probe
 * either.
 *
 * A checkout outlives the run that used it, so a notice left behind would
 * tell the *next* agent to wind down the moment it starts.
 * {@link clearWindDownNotice} removes any stale notice at run start.
 *
 * Pure but for {@link writeWindDownNotice}; the clock is an input everywhere
 * else.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  decideQualityGateRun,
  formatQualityGateSkipNote,
} from "./quality_gate_budget.ts";

/** Where the notice is written, relative to the agent's checkout. */
export const WIND_DOWN_NOTICE_FILENAME = ".vibe-run-budget.md";

/**
 * The heading suffix a notice carries only when it is a wind-down order.
 *
 * Since Issue #1138 the file is also written in the wider band where the
 * quality gate no longer fits but the run is fine, so its mere existence no
 * longer means "this run was warned it was running out of budget". Anything
 * that wants that answer — the handover note does — must read the contents,
 * and this is what it reads.
 */
export const WIND_DOWN_HEADING_MARKER = "— wind down now";

/** True when a written notice actually ordered the agent to wind down. */
export function noticeOrdersWindDown(contents: string): boolean {
  return contents.includes(WIND_DOWN_HEADING_MARKER);
}

/**
 * Seconds of runway at or below which the agent is told to wind down.
 *
 * Ten minutes: long enough for an agent mid-poll to stop, commit and write a
 * resumable note, and comfortably wider than the default 300 s check interval
 * so at least one check lands inside the window.
 */
export const DEFAULT_WIND_DOWN_SECONDS = 600;

/** What the agent is told about its remaining budget. */
export interface RunBudgetNotice {
  /** Seconds left before the run hard cap stops this run. */
  remainingSeconds: number;
  /** Seconds the run has been going. */
  elapsedSeconds: number;
  /** Deadline extensions granted so far. */
  extensionsGranted: number;
  /**
   * What the full quality gate took on this repository, when something
   * measured it (Issue #1138). Absent, the fleet-wide assumption in
   * `quality_gate_budget.ts` decides whether the gate still fits.
   */
  typicalGateSeconds?: number;
  /**
   * The wind-down window this run is using, when it is not the default
   * (Issue #1138). The notice is written over a wider band than the window —
   * see {@link shouldWriteRunBudgetNotice} — so it has to know where the
   * window itself ends before it can tell an agent to wind down.
   */
  windDownSeconds?: number;
}

/**
 * Whether the run is close enough to the cap to tell the agent to wind down.
 *
 * @param remainingSeconds - Runway left before the hard cap.
 * @param windDownSeconds - Window width; defaults to
 *   {@link DEFAULT_WIND_DOWN_SECONDS}.
 * @returns true when the wind-down instructions apply.
 */
export function shouldWindDown(
  remainingSeconds: number,
  windDownSeconds: number = DEFAULT_WIND_DOWN_SECONDS,
): boolean {
  return remainingSeconds <= windDownSeconds;
}

/**
 * Whether the notice should be written at all (Issue #1138).
 *
 * Wider than {@link shouldWindDown}, and deliberately so. The wind-down
 * window is ten minutes; the quality gate needs closer to twenty. An agent at
 * 1000 s of runway is not winding down — but it cannot finish a gate either,
 * and under the narrower rule nothing told it so: no notice existed, so the
 * budget condition in its prompt could not be evaluated and it started a gate
 * that outlived the run. That band is where the Issue #1138 measurements
 * found agents dying, so the notice has to reach into it.
 *
 * @param remainingSeconds - Runway left before the hard cap.
 * @param windDownSeconds - Wind-down window; defaults to
 *   {@link DEFAULT_WIND_DOWN_SECONDS}.
 * @param typicalGateSeconds - Measured gate duration, when known.
 * @returns true when the notice should be written or refreshed.
 */
export function shouldWriteRunBudgetNotice(
  remainingSeconds: number,
  windDownSeconds: number = DEFAULT_WIND_DOWN_SECONDS,
  typicalGateSeconds?: number,
): boolean {
  if (shouldWindDown(remainingSeconds, windDownSeconds)) return true;
  return !decideQualityGateRun({
    remainingSeconds,
    ...(typicalGateSeconds === undefined ? {} : { typicalGateSeconds }),
  }).run;
}

/**
 * Render the notice the agent reads.
 *
 * @param notice - Remaining budget, elapsed time and extensions granted.
 * @returns Markdown, written verbatim to {@link WIND_DOWN_NOTICE_FILENAME}.
 */
export function buildWindDownNotice(notice: RunBudgetNotice): string {
  return [
    ...budgetHeader(notice),
    ...windDownInstructions(notice),
    ...gateRefusal(notice),
    "This file is worker state. It is gitignored — never commit it.",
    "",
  ].join("\n");
}

/** The budget statement, whether or not the run is winding down. */
function budgetHeader(notice: RunBudgetNotice): string[] {
  const winding = shouldWindDown(
    notice.remainingSeconds,
    notice.windDownSeconds,
  );
  return [
    `# Run budget: ${notice.remainingSeconds}s remaining${
      winding ? ` ${WIND_DOWN_HEADING_MARKER}` : ""
    }`,
    "",
    ...(winding
      ? [
        "The worker wrote this file because your run is approaching its hard",
        "wall-clock cap. When the cap is reached the run is stopped: SIGTERM,",
        "then SIGKILL after the grace period. No further deadline extension",
        "can be granted past the cap, however much progress you are making.",
      ]
      : [
        "The worker wrote this file because the runway left no longer covers",
        "something you might be about to start — see below. The run itself is",
        "not over: keep working, and read this file again before you begin",
        "anything long.",
      ]),
    "",
    `- Remaining before the cap: **${notice.remainingSeconds}s**`,
    `- Elapsed so far: ${notice.elapsedSeconds}s`,
    `- Deadline extensions granted: ${notice.extensionsGranted}`,
    "",
  ];
}

/**
 * What to do inside the wind-down window itself — emitted only there.
 *
 * A run with more runway than the window is not winding down; telling it to
 * stop waiting and push would end perfectly good runs early, which is the
 * opposite of what the wider notice band is for.
 */
function windDownInstructions(notice: RunBudgetNotice): string[] {
  if (!shouldWindDown(notice.remainingSeconds, notice.windDownSeconds)) {
    return [];
  }
  return [
    "## What to do now",
    "",
    "1. **Stop waiting.** Do not start another poll of a background job, and",
    "   do not begin work you cannot finish in the time above.",
    "2. **Commit and push** what you have on the issue branch, so the next",
    "   run resumes from it rather than starting again.",
    "3. **Leave a resumable note** — in your final message and in the PR",
    "   summary — saying what you were waiting for, how far it had got, and",
    "   the exact next step. The next run reads that instead of paying the",
    "   whole ramp-up again.",
    "",
  ];
}

/**
 * The gate refusal (Issue #1138), emitted only when the remaining budget
 * cannot cover the full quality gate plus the tail needed to act on it.
 *
 * A gate that still fits is not discussed at all: the notice's job is to stop
 * an agent starting work it cannot finish, not to talk it out of work it can.
 */
function gateRefusal(notice: RunBudgetNotice): string[] {
  const decision = decideQualityGateRun({
    remainingSeconds: notice.remainingSeconds,
    ...(notice.typicalGateSeconds === undefined
      ? {}
      : { typicalGateSeconds: notice.typicalGateSeconds }),
  });
  if (decision.run) return [];

  return [
    "## Do not start the full quality gate",
    "",
    decision.reason,
    "",
    "Run the targeted checks instead — formatter, linter, type check and the",
    "tests covering what you changed — then record the skip in the PR summary",
    "(or `.pr_response_message`) with this note, verbatim:",
    "",
    "```markdown",
    formatQualityGateSkipNote(decision),
    "```",
    "",
  ];
}

/**
 * Write (or refresh) the notice in the agent's checkout.
 *
 * Fails loud: a write that cannot complete throws, so a broken notice channel
 * is visible in the worker log rather than silently leaving the agent
 * uninformed.
 *
 * @param dir - The agent's working directory.
 * @param notice - Remaining budget, elapsed time and extensions granted.
 */
export async function writeWindDownNotice(
  dir: string,
  notice: RunBudgetNotice,
): Promise<void> {
  await Deno.writeTextFile(
    `${dir}/${WIND_DOWN_NOTICE_FILENAME}`,
    buildWindDownNotice(notice),
  );
}

/**
 * Remove a notice left behind by an earlier run in the same checkout.
 *
 * Fails loud on anything but "it was not there": a notice that cannot be
 * removed would have the next agent wind down before it started.
 *
 * @param dir - The agent's working directory.
 */
export async function clearWindDownNotice(dir: string): Promise<void> {
  try {
    await Deno.remove(`${dir}/${WIND_DOWN_NOTICE_FILENAME}`);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return;
    throw err;
  }
}

/**
 * What the agent is told about the notice, up front, in the issue prompt.
 *
 * Without this the file is invisible: nothing else tells a running agent that
 * a budget channel exists at all.
 */
export const WIND_DOWN_PROMPT_SECTION =
  `## Run Budget — Check It Before You Wait

Your run has a wall-clock cap. While you supervise a long-running job the
worker keeps extending your deadline as long as the job is genuinely
consuming CPU, but the cap itself is absolute.

The worker writes \`${WIND_DOWN_NOTICE_FILENAME}\` in the repository root once
the runway left can no longer cover something you might be about to start —
the full quality gate first, then the run itself. **Read it between polls of
any long-running job, and before you start the gate**
(\`cat ${WIND_DOWN_NOTICE_FILENAME}\`).

Do what the file says, not what its existence implies: it states the seconds
remaining, refuses the full quality gate when the runway cannot cover it, and
— inside the last few minutes before the cap — tells you to stop waiting,
commit and push what you have, and record in your final message what you were
waiting for and the exact next step, so the next run resumes instead of
starting again.

The file is worker state and is gitignored — never commit it.
`;
