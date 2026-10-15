/**
 * The attempt log of one review-fleet-prs round (see `review_round.ts`).
 *
 * Kept apart from `review_round.ts`, which pulls in the credential pool, so
 * the skill's own scripts (`post.ts`, `review_cost.ts`) can read the log
 * without importing it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

/**
 * The round's attempt log, in the round's own directory (beside its
 * `prompt.md`): which provider, model and effort each `claude -p` attempt ran
 * on, the file its stream-json output went to, and — once it ended — its exit
 * status. `post.ts` reads the attempt still running to name the model in the
 * review it posts, and the runner prices each ended attempt from its stream
 * afterwards (`review_cost.ts`). An attempt with no `code` never ended: the
 * runner's alarm killed it, so its stream is not the whole attempt.
 */
export const REVIEW_RUN_FILE = "review-run.json";

/** One `claude -p` attempt of a round, as {@link REVIEW_RUN_FILE} records it. */
export interface ReviewRunAttempt {
  /** 1 for the first attempt, counting up across rotations and fallbacks. */
  attempt: number;
  /** The provider the attempt ran on (`claude`, or the fallback's id). */
  provider: string;
  /** The `--model` the attempt asked for, or null when none was passed. */
  model: string | null;
  /** The `--effort` the attempt asked for, or null when none was passed. */
  effort: string | null;
  /** The attempt's stream-json output, relative to the round directory. */
  stream: string;
  /** The CLI's exit status; absent while the attempt runs. */
  code?: number;
}

/** The whole attempt log of one round. */
export interface ReviewRunRecord {
  /** The round's id: its directory's name (`20261016-101500`). */
  round: string;
  attempts: ReviewRunAttempt[];
}
