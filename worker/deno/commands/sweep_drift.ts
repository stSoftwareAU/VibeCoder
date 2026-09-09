/**
 * Print per-slice sweep drift since each slice's `sweptAt` (Issue #1609).
 *
 * The delta-sweep issues (#1610, #1611, #1612) regenerate their file lists
 * from this report rather than from stale counts in the issue body.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import {
  driftSince,
  LIB_SWEEP_LEDGER_PATH,
  listSweptModulesForRoots,
  parseCoverageLedger,
  type SliceDrift,
  type SweepCoverageLedger,
  type SweepGitRunner,
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

/** Default git runner — the shared timeout/audit chokepoint. */
export async function defaultSweepGitRunner(
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await runGitCommand([...args]);
  if (!result.ok) {
    return { code: 1, stdout: "", stderr: result.error.message };
  }
  return result.value;
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
    const json = await Deno.readTextFile(
      `${repoRoot}/${LIB_SWEEP_LEDGER_PATH}`,
    );
    const ledger = parseCoverageLedger(json);
    const onDisk = await listSweptModulesForRoots(repoRoot, ledger.roots);
    const runGit = typeof args.runGit === "function"
      ? args.runGit as SweepGitRunner
      : defaultSweepGitRunner;
    const blocks = await collectSweepDrift(ledger, onDisk, runGit);
    const message = formatSweepDriftReport(blocks);
    return { success: true, message, data: { blocks } };
  },
};
