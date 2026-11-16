/**
 * Detects a branch whose only changes are the run's own record files — the
 * PR summary and the PR response message — so change detection can treat it as
 * "no changes" rather than raising a PR with no deliverable (Issue #5070).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { GitRunner } from "./git_base_ref.ts";
import { prSummaryFilePath } from "./pr_body_length.ts";
import { PR_RESPONSE_MESSAGE_FILE } from "./worker_state_paths.ts";

/** The exact repo-relative paths a run writes as its own record. */
export function runRecordPaths(issueNumber: number): ReadonlySet<string> {
  return new Set([prSummaryFilePath(issueNumber), PR_RESPONSE_MESSAGE_FILE]);
}

/**
 * True iff `paths` is non-empty and every path is one of this run's own record
 * files. Another issue's summary or a nested lookalike is real work.
 */
export function changesOnlyRunRecords(
  paths: readonly string[],
  issueNumber: number,
): boolean {
  if (paths.length === 0) return false;
  const records = runRecordPaths(issueNumber);
  return paths.every((p) => records.has(p));
}

/**
 * Every path the branch changes relative to `baseRef`: committed since the
 * merge base, tracked-uncommitted, and untracked (not ignored). De-duplicated.
 * A git failure is an error, never an empty list.
 */
export async function readBranchChangedPaths(
  runGit: GitRunner,
  baseRef: string,
  options: { cwd?: string },
): Promise<Result<string[], Error>> {
  const commands: string[][] = [
    ["diff", "--name-only", "-z", "--end-of-options", `${baseRef}...HEAD`],
    ["diff", "--name-only", "-z", "HEAD"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ];
  const paths = new Set<string>();
  for (const args of commands) {
    const label = `git ${args.join(" ")}`;
    const result = await runGit(args, { cwd: options.cwd });
    if (!result.ok) {
      return {
        ok: false,
        error: new Error(`${label} could not run: ${result.error.message}`),
      };
    }
    if (result.value.code !== 0) {
      const firstLine = result.value.stderr.split("\n").map((l) => l.trim())
        .find((l) => l.length > 0) ?? "";
      return {
        ok: false,
        error: new Error(
          `${label} exited ${result.value.code}${
            firstLine ? `: ${firstLine}` : ""
          }`,
        ),
      };
    }
    for (const p of result.value.stdout.split("\0")) {
      if (p.length > 0) paths.add(p);
    }
  }
  return { ok: true, value: [...paths] };
}
