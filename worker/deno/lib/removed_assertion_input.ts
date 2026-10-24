/**
 * Gathers the removed-assertion gate's input from git (Issue #3131), shared by
 * the completion phase and the local `pr-summary-check` (Issue #4234).
 *
 * The completion phase used to read the test-file patch inline. It now calls
 * {@link readRemovedAssertionInput} and keeps the same behaviour byte for byte:
 * the same pathspec, the same read cap, the same fail-closed `null` on any git
 * failure, and the same warning texts. Pure apart from the injected git
 * runner and logger.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { GitRunner } from "./git_base_ref.ts";
import {
  MAX_DIFF_CHARS,
  pathsFromRenameStatus,
  removedAssertionDiffArgs,
  removedAssertionRenameStatusArgs,
} from "./removed_assertion_gate.ts";
import { isTestFilePath } from "./security_fix_gate.ts";

/** Input to {@link readRemovedAssertionInput}. */
export interface RemovedAssertionInputOpts {
  /**
   * Runs git with the caller's working directory already bound (the completion
   * phase binds the checkout; the local check binds the repo root). A non-ok
   * result or a non-zero exit is a git failure.
   */
  runGit: GitRunner;
  /** The comparable base ref, or `null` when it could not be resolved. */
  base: string | null;
  /** The branch's changed files, as listed against the base. */
  changedFiles: readonly string[];
  /** False when the changed-files list could not be read at all. */
  changedFilesKnown: boolean;
  /** Receives the same warnings the completion phase has always logged. */
  logger?: { warn(message: string): void };
}

/** What the removed-assertion gate reads from git. */
export interface RemovedAssertionInput {
  /**
   * The unified test-file patch, or `null` when it was not read: no base, a
   * git failure, a patch at or past the read cap, or no test file to read.
   */
  testDiff: string | null;
  /**
   * Test files on either side of a rename or in the changed list. The caller
   * merges these into `changedFiles` for `validateRemovedAssertions`.
   */
  testFiles: string[];
}

/**
 * Read the test-file patch the removed-assertion gate scans.
 *
 * When the changed-files list is known, the patch is scoped to the test files
 * by a pathspec from `git diff --name-status -z --find-renames`, so a large
 * unrelated hunk can never push a test file's own patch past the read cap.
 * When that list is unknown, the gate must apply, so the full branch patch is
 * read. A patch that cannot be read is never a silent pass: it is logged and
 * `testDiff` stays `null`.
 */
export async function readRemovedAssertionInput(
  opts: RemovedAssertionInputOpts,
): Promise<RemovedAssertionInput> {
  const { runGit, base, changedFiles, changedFilesKnown, logger } = opts;

  let testFiles: string[] = [];
  let pathspec: string[] = [];
  let sidesKnown = !changedFilesKnown;
  if (base !== null && changedFilesKnown) {
    const sides = await runGit(removedAssertionRenameStatusArgs(base));
    if (sides.ok && sides.value.code === 0) {
      const parsed = pathsFromRenameStatus(sides.value.stdout);
      testFiles = parsed.testFiles;
      pathspec = parsed.pathspec;
      sidesKnown = true;
    } else {
      logger?.warn(
        "Could not list both sides of renamed test files for the removed-assertion gate — only the Test Plan heading rule applies",
      );
    }
  }

  const couldApply = !changedFilesKnown || testFiles.length > 0 ||
    changedFiles.some((file) => isTestFilePath(file));
  let testDiff: string | null = null;
  if (base !== null && couldApply && sidesKnown) {
    const diff = await runGit(removedAssertionDiffArgs(base, pathspec));
    if (diff.ok && diff.value.code === 0) {
      if (diff.value.stdout.length >= MAX_DIFF_CHARS) {
        logger?.warn(
          "The test-file diff for the removed-assertion gate reached the read cap — treating it as unreadable rather than scanning a silently truncated patch",
        );
      } else {
        testDiff = diff.value.stdout;
      }
    } else {
      logger?.warn(
        "Could not read the test-file diff for the removed-assertion gate — only the Test Plan heading rule applies",
      );
    }
  }

  return { testDiff, testFiles };
}
