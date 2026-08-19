/**
 * Worker-side idle-task wrapper seeding for another monitored repo
 * (Issue #3860).
 *
 * Drives the full lifecycle for one `seed-idle-tasks: owner/repo` issue and
 * signals the outcome by commenting on (and closing) that issue. The agent is
 * never spawned for such an issue, so the #3311 / #3643 boundary is untouched:
 * the **worker** performs every write, through the `spawnGh` chokepoint and
 * into the audit journal.
 *
 * Order of operations:
 *
 *   1. {@link parseSeedIdleTasksTitle} — the target slug comes from the issue
 *      **title** only. An unparseable title is commented on and closed.
 *   2. {@link resolveMonitoredRepo} — the slug is matched against the fleet
 *      `.config.json` `repos` list and replaced by the **config entry**. A
 *      repo absent from that list is refused, with the reason posted on the
 *      issue, and nothing is registered or written to the target.
 *   3. `seedWriteRepoAllowlist(requestRepo)` + `registerWriteRepo(target)` —
 *      the run may now write to the requesting repo (comment/close) and to
 *      the operator-approved target, and nothing else.
 *   4. {@link createAllIdleTaskWrappers} — idempotent; already-open wrappers
 *      are reported as skipped rather than duplicated.
 *   5. A per-template created/skipped summary is posted on the requesting
 *      issue, which is then closed as completed. A seeding failure is
 *      reported loudly and the issue is left **open** so the next loop
 *      iteration retries (the helper is idempotent, so a retry is safe).
 *
 * The allowlist is reset in a `finally` once the summary comment is posted,
 * so this run's cross-repo grant never leaks into the next claim.
 *
 * Every external dependency (`gh` runner, seeding helper, clock) is injected
 * so the whole flow is unit-testable with scripted responses and no network.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type {
  Command,
  CommandResult,
  Logger,
  Result,
  WorkerConfig,
} from "../types.ts";
import {
  createAllIdleTaskWrappers,
  type CreateAllIdleTaskWrappersResult,
} from "../lib/create_all_idle_task_wrappers.ts";
import { runGhCommand as defaultGhCommand } from "../lib/github.ts";
import {
  parseSeedIdleTasksTitle,
  resolveMonitoredRepo,
} from "../lib/seed_idle_tasks_request.ts";
import {
  registerWriteRepo,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
} from "../lib/write_repo_allowlist.ts";
import { createLogger } from "../lib/logger.ts";

// ---------------------------------------------------------------------------
// Public data shape
// ---------------------------------------------------------------------------

/** Outcome reported back via `CommandResult.data`. */
export interface ProcessSeedIdleTasksData {
  /** Discriminated outcome of the run. */
  outcome: "unparseable" | "not_monitored" | "seeded" | "error";
  /** The resolved target repo (always the config entry), when resolved. */
  repo?: string;
  /** Template names whose wrapper was newly filed. */
  created?: string[];
  /** Template names skipped because an open wrapper already existed. */
  skipped?: string[];
}

/** Injectable dependencies; every seam defaults to production. */
export interface ProcessSeedIdleTasksDeps {
  /** String-returning `gh` runner (comment/close on the requesting issue). */
  runGhCommand?: (args: string[]) => Promise<string>;
  /** Seeding seam. Defaults to {@link createAllIdleTaskWrappers}. */
  createWrappersFn?: (
    repo: string,
  ) => Promise<Result<CreateAllIdleTaskWrappersResult>>;
  /** Clock, threaded into wrapper seeding. */
  now?: () => Date;
  /** Logger. Defaults to {@link createLogger}. */
  logger?: Logger;
}

// ---------------------------------------------------------------------------
// Comment builders (exported for testing)
// ---------------------------------------------------------------------------

/** Comment posted when the title carries no valid `owner/repo`. */
export function buildUnparseableComment(title: string): string {
  return (
    "## Idle-task seeding could not start\n\n" +
    "Could not parse an `owner/repo` from this title:\n\n" +
    `> ${title.trim()}\n\n` +
    "Re-open with a title of the form `seed-idle-tasks: owner/repo` " +
    "(for example `seed-idle-tasks: example-org/private-repo-29`)."
  );
}

/**
 * Refusal comment for a target that is not in the fleet `.config.json`
 * `repos` list. Names the requested slug so the operator can see exactly what
 * was refused, and says what to do instead.
 */
export function buildNotMonitoredComment(requested: string): string {
  return (
    "## Idle-task seeding refused\n\n" +
    `\`${requested}\` is **not** in the fleet \`.config.json\` \`repos\` ` +
    "list, so the worker will not write to it.\n\n" +
    "The seeding target must come from operator-controlled config — that is " +
    "what keeps this cross-repo path safe (Issue #3860). Add the repo to " +
    "the monitored set first (file an `add-repo: owner/repo` issue), then " +
    "re-file this request."
  );
}

/** Success summary comment posted before closing the requesting issue. */
export function buildSeededComment(opts: {
  repo: string;
  created: readonly string[];
  skipped: readonly string[];
}): string {
  const createdLine = opts.created.length > 0
    ? opts.created.join(", ")
    : "none";
  const skippedLine = opts.skipped.length > 0
    ? opts.skipped.join(", ")
    : "none";
  return (
    "## Idle-task wrappers seeded\n\n" +
    `- **Target repository:** \`${opts.repo}\` (resolved from the ` +
    "monitored-repo config)\n" +
    `- **Created:** ${createdLine}\n` +
    `- **Skipped (already open):** ${skippedLine}\n\n` +
    "Seeding ran in the worker process, so every issue-create passed the " +
    "write-repo allowlist and was recorded in the audit journal."
  );
}

/** Failure comment posted when seeding could not complete. */
export function buildSeedFailureComment(
  repo: string,
  error: string,
): string {
  return (
    "## Idle-task seeding failed\n\n" +
    `Seeding wrappers in \`${repo}\` did not complete:\n\n` +
    "```text\n" + error + "\n```\n\n" +
    "This issue is left open — seeding is idempotent, so the next worker " +
    "pass retries safely."
  );
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const processSeedIdleTasksCommand: Command = {
  name: "process-seed-idle-tasks",
  description:
    "Seed all idle-task wrappers in another monitored repo on behalf of a " +
    "`seed-idle-tasks: owner/repo` issue: validate the target against the " +
    "config `repos` allowlist, register it for this run, seed, then comment " +
    "and close. Issue #3860.",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<ProcessSeedIdleTasksData>> {
    const repo = String(args["repo"] ?? "");
    const issueNumber = Number(args["issue-number"]);
    const title = String(args["title"] ?? "");

    const deps: ProcessSeedIdleTasksDeps =
      (args["__testDeps"] as ProcessSeedIdleTasksDeps | undefined) ?? {};
    const logger = deps.logger ?? createLogger();
    const runGhCommand = deps.runGhCommand ?? defaultGhCommand;
    const now = deps.now ?? (() => new Date());
    const createWrappersFn = deps.createWrappersFn ??
      ((r: string) =>
        createAllIdleTaskWrappers(r, {
          ghCommandFn: runGhCommand,
          nowFn: now,
        }));

    if (repo.length === 0) {
      return { success: false, message: "Missing required argument: --repo" };
    }
    if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
      return {
        success: false,
        message: "Missing or invalid required argument: --issue-number",
      };
    }

    // -------------------------------------------------------------------
    // Step 1: parse the target from the issue TITLE (never the body).
    // -------------------------------------------------------------------
    const parsed = parseSeedIdleTasksTitle(title);
    if (parsed === null) {
      logger.info("process-seed-idle-tasks: unparseable title", {
        repo,
        title,
      });
      await closeWithComment(
        runGhCommand,
        repo,
        issueNumber,
        buildUnparseableComment(title),
        "not planned",
        logger,
      );
      return {
        success: true,
        message:
          "process-seed-idle-tasks: unparseable title — commented and closed",
        data: { outcome: "unparseable" },
      };
    }

    // -------------------------------------------------------------------
    // Step 2: resolve against operator config. The value used from here on
    // is the `.config.json` entry, not the text from the issue.
    // -------------------------------------------------------------------
    const target = resolveMonitoredRepo(parsed.repo, config.repos ?? []);
    if (target === null) {
      logger.warn("process-seed-idle-tasks: target not monitored — refused", {
        repo,
        issueNumber,
        requested: parsed.repo,
      });
      await closeWithComment(
        runGhCommand,
        repo,
        issueNumber,
        buildNotMonitoredComment(parsed.repo),
        "not planned",
        logger,
      );
      return {
        success: true,
        message:
          `process-seed-idle-tasks: refused — ${parsed.repo} is not in the ` +
          "monitored repos config",
        data: { outcome: "not_monitored" },
      };
    }

    // -------------------------------------------------------------------
    // Step 3-5: grant, seed, report. The grant covers exactly two repos —
    // the requesting issue's own repo and the operator-approved target.
    // -------------------------------------------------------------------
    seedWriteRepoAllowlist(repo);
    registerWriteRepo(target);
    try {
      logger.info("process-seed-idle-tasks: seeding wrappers", {
        repo,
        issueNumber,
        target,
      });
      const wrapResult = await createWrappersFn(target);

      if (!wrapResult.ok) {
        const message = wrapResult.error.message;
        logger.error("process-seed-idle-tasks: seeding failed", {
          target,
          error: message,
        });
        await postComment(
          runGhCommand,
          repo,
          issueNumber,
          buildSeedFailureComment(target, message),
          logger,
        );
        return {
          success: false,
          message:
            `process-seed-idle-tasks: seeding failed for ${target}: ${message}`,
          data: { outcome: "error", repo: target },
        };
      }

      const { created, skipped } = wrapResult.value;
      await closeWithComment(
        runGhCommand,
        repo,
        issueNumber,
        buildSeededComment({ repo: target, created, skipped }),
        "completed",
        logger,
      );

      return {
        success: true,
        message: `process-seed-idle-tasks: ${target} seeded — ` +
          `created=${created.length} skipped=${skipped.length}`,
        data: { outcome: "seeded", repo: target, created, skipped },
      };
    } finally {
      // Do not let this run's cross-repo grant leak into the next claim.
      resetWriteRepoAllowlist();
    }
  },
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Post a comment on the requesting issue, warning loudly on failure. */
async function postComment(
  gh: (args: string[]) => Promise<string>,
  repo: string,
  issueNumber: number,
  comment: string,
  logger: Logger,
): Promise<void> {
  try {
    await gh([
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      comment,
    ]);
  } catch (err) {
    logger.warn("process-seed-idle-tasks: failed to comment on issue", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Close the requesting issue with the given reason, attaching a comment. */
async function closeWithComment(
  gh: (args: string[]) => Promise<string>,
  repo: string,
  issueNumber: number,
  comment: string,
  reason: "completed" | "not planned",
  logger: Logger,
): Promise<void> {
  try {
    await gh([
      "issue",
      "close",
      String(issueNumber),
      "--repo",
      repo,
      "--reason",
      reason,
      "--comment",
      comment,
    ]);
  } catch (err) {
    logger.warn("process-seed-idle-tasks: failed to comment/close issue", {
      repo,
      issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
