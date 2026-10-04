/**
 * Print per-slice sweep drift since each slice's `sweptAt` (Issue #1609).
 *
 * The delta-sweep issues (#1610, #1611, #1612) regenerate their file lists
 * from this report rather than from stale counts in the issue body.
 *
 * With `--default-branch <ref>` (e.g. `origin/main`) it first fails unless
 * every slice's `sweptAt` is on that branch (Issue #2754) — the full-history
 * CI guard against a top-up recording a squash-doomed feature-branch commit.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  driftSince,
  listSweptModulesForRoots,
  readCoverageLedger,
  type SliceDrift,
  type SweepCoverageLedger,
  type SweepGitRunner,
  SweepLedgerError,
  verifySweptAtsOnDefaultBranch,
} from "../lib/lib_sweep_coverage.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import type { Command, CommandResult, WorkerConfig } from "../types.ts";

/** One printed slice block. */
export interface SweepDriftBlock {
  chunk: string;
  issue: number;
  title: string;
  sweptAt: string;
  drift: SliceDrift;
}

/**
 * Default git runner — the shared timeout/audit chokepoint — rooted at the
 * repository the report is about (Issue #2178).
 *
 * `driftSince` passes repo-relative pathspecs, which git resolves against the
 * working directory. Run from anywhere but the repository root they matched
 * nothing and every slice reported an empty drift: a clean bill of health for
 * a ledger nobody had diffed. Pinning git's cwd to `repoRoot` makes the
 * `--repo` argument mean the same thing for git as it does for the ledger.
 *
 * @param repoRoot - Absolute path of the repository to diff.
 */
export function sweepGitRunnerFor(repoRoot: string): SweepGitRunner {
  return async (args) => {
    const result = await runGitCommand([...args], { cwd: repoRoot });
    if (!result.ok) {
      return { code: 1, stdout: "", stderr: result.error.message };
    }
    return result.value;
  };
}

/** Render one block per slice: counts plus paths. */
export function formatSweepDriftReport(
  blocks: readonly SweepDriftBlock[],
): string {
  return blocks.map((block) => {
    const { drift } = block;
    return [
      `## ${block.chunk} (#${block.issue}) ${block.title}`,
      `sweptAt: ${block.sweptAt}`,
      `added (${drift.added.length}):`,
      ...drift.added.map((path) => `  - ${path}`),
      `modified (${drift.modified.length}):`,
      ...drift.modified.map((path) => `  - ${path}`),
      `unowned (${drift.unowned.length}):`,
      ...drift.unowned.map((path) => `  - ${path}`),
    ].join("\n");
  }).join("\n\n");
}

/**
 * Build the drift report from a parsed ledger.
 *
 * @param ledger - Parsed coverage ledger.
 * @param onDisk - Non-test modules on disk.
 * @param runGit - Injected git runner.
 */
export async function collectSweepDrift(
  ledger: SweepCoverageLedger,
  onDisk: readonly string[],
  runGit: SweepGitRunner,
): Promise<SweepDriftBlock[]> {
  const blocks: SweepDriftBlock[] = [];
  for (const slice of ledger.slices) {
    const drift = await driftSince(ledger, slice, onDisk, runGit);
    blocks.push({
      chunk: slice.chunk,
      issue: slice.issue,
      title: slice.title,
      sweptAt: slice.sweptAt,
      drift,
    });
  }
  return blocks;
}

export const sweepDriftCommand: Command = {
  name: "sweep-drift",
  description:
    "Report modules added or modified since each sweep slice's sweptAt commit",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<{ blocks: SweepDriftBlock[] }>> {
    const repoRoot = typeof args.repo === "string" && args.repo.length > 0
      ? args.repo
      : Deno.cwd();
    const ledger = await readCoverageLedger(repoRoot);
    const onDisk = await listSweptModulesForRoots(repoRoot, ledger.roots);
    const runGit = typeof args.runGit === "function"
      ? args.runGit as SweepGitRunner
      : sweepGitRunnerFor(repoRoot);
    const defaultRef = typeof args["default-branch"] === "string"
      ? args["default-branch"].trim()
      : "";
    if (defaultRef.length > 0) {
      try {
        await verifySweptAtsOnDefaultBranch(ledger, defaultRef, runGit);
      } catch (error) {
        if (!(error instanceof SweepLedgerError)) throw error;
        return { success: false, message: error.message };
      }
    }
    const blocks = await collectSweepDrift(ledger, onDisk, runGit);
    const message = formatSweepDriftReport(blocks);
    return { success: true, message, data: { blocks } };
  },
};
