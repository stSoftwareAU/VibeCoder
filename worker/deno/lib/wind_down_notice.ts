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

/** Where the notice is written, relative to the agent's checkout. */
export const WIND_DOWN_NOTICE_FILENAME = ".vibe-run-budget.md";

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
}

/**
 * Whether the run is close enough to the cap to warn the agent.
 *
 * @param remainingSeconds - Runway left before the hard cap.
 * @param windDownSeconds - Window width; defaults to
 *   {@link DEFAULT_WIND_DOWN_SECONDS}.
 * @returns true when the notice should be written or refreshed.
 */
export function shouldWindDown(
  remainingSeconds: number,
  windDownSeconds: number = DEFAULT_WIND_DOWN_SECONDS,
): boolean {
  return remainingSeconds <= windDownSeconds;
}

/**
 * Render the notice the agent reads.
 *
 * @param notice - Remaining budget, elapsed time and extensions granted.
 * @returns Markdown, written verbatim to {@link WIND_DOWN_NOTICE_FILENAME}.
 */
export function buildWindDownNotice(notice: RunBudgetNotice): string {
  return [
    `# Run budget: ${notice.remainingSeconds}s remaining — wind down now`,
    "",
    "The worker wrote this file because your run is approaching its hard",
    "wall-clock cap. When the cap is reached the run is stopped: SIGTERM,",
    "then SIGKILL after the grace period. No further deadline extension can",
    "be granted past the cap, however much progress you are making.",
    "",
    `- Remaining before the cap: **${notice.remainingSeconds}s**`,
    `- Elapsed so far: ${notice.elapsedSeconds}s`,
    `- Deadline extensions granted: ${notice.extensionsGranted}`,
    "",
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
    "This file is worker state. It is gitignored — never commit it.",
    "",
  ].join("\n");
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

When the run comes within a few minutes of that cap the worker writes
\`${WIND_DOWN_NOTICE_FILENAME}\` in the repository root, holding the seconds
you have left. **Read it between polls of any long-running job**
(\`cat ${WIND_DOWN_NOTICE_FILENAME}\`). If the file exists, stop waiting: commit
and push what you have, then record in your final message what you were
waiting for and the exact next step, so the next run resumes instead of
starting again.

The file is worker state and is gitignored — never commit it.
`;
