/**
 * CLI entry point for the four-phase security scan (Issues #1940, #2097).
 *
 * Invokes `runSecurityScan` with arguments parsed from the command
 * line. As of Issue #2097 the contract is outcome-only — Claude files
 * findings itself via `gh issue create` and the executor returns only
 * `{ ok: true }` on success or a structured error on failure. The
 * per-finding diff lives in the idle-task template, not in this
 * command.
 *
 * Arguments:
 *   --repo                       Repository in `owner/repo` format (required).
 *   --work-dir                   Working directory passed to Claude as cwd
 *                                (required).
 *   --suppressed-ids             Comma-separated stable finding IDs to drop.
 *   --known-open-finding-ids     Comma-separated stable finding IDs that
 *                                already have an open GitHub issue. Unioned
 *                                with the fleet-authored list this command
 *                                builds itself.
 *   --timeout-seconds            Hard wall-clock cap on the Claude scan.
 *
 * Issue #2159 (v8 prompt): the `--language-hints` argument was retired —
 * the scanner agent now detects dominant languages at scan time as step
 * zero of the Phase 1 inventory.
 *
 * Output: JSON. On success: `{ ok: true }`. On failure: `{ error: {
 * kind, message, partialOutput? } }`.
 *
 * Australian English spelling used throughout.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  runSecurityScan,
  type ScanError,
  type ScanOk,
} from "../lib/security_scanner.ts";
import {
  listAllOpenIssueTitles,
  listKnownOpenFindingIds,
} from "../lib/idle_task_snapshot.ts";
import { runGhCommand } from "../lib/github.ts";

/** Split a comma-separated CLI arg into a trimmed, non-empty list. */
function splitCsv(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

type RunSecurityScanData = ScanOk | { error: ScanError };

/** Injected runners. Production uses `gh` and {@link runSecurityScan}. */
export interface RunSecurityScanCommandDeps {
  ghCommandFn?: (args: string[]) => Promise<string>;
  runSecurityScanFn?: typeof runSecurityScan;
  /** Tests name the fleet. Production omits this and uses the configured identity. */
  fleetAuthors?: readonly string[];
}

/**
 * Run the security scan, filling known-open `SEC-` ids from fleet-authored
 * issues (Issue #3045, PR #3068 review). A `--known-open-finding-ids` flag
 * is unioned with that list; omitting the flag does not leave the list empty.
 */
export async function executeRunSecurityScan(
  args: Record<string, unknown>,
  deps: RunSecurityScanCommandDeps = {},
): Promise<CommandResult<RunSecurityScanData>> {
  const repo = String(args["repo"] ?? "");
  const workDir = String(args["work-dir"] ?? "");

  if (!repo) {
    return { success: false, message: "Missing required argument: --repo" };
  }
  if (!workDir) {
    return {
      success: false,
      message: "Missing required argument: --work-dir",
    };
  }

  const gh = deps.ghCommandFn ?? ((ghArgs: string[]) => runGhCommand(ghArgs));
  const scan = deps.runSecurityScanFn ?? runSecurityScan;
  const suppressedIds = splitCsv(args["suppressed-ids"]);
  const flaggedIds = splitCsv(args["known-open-finding-ids"]);
  const listedIds = await listKnownOpenFindingIds(
    repo,
    "security",
    gh,
    "SEC-",
    deps.fleetAuthors ? { fleetAuthors: [...deps.fleetAuthors] } : {},
  );
  const knownOpenFindingIds = [...new Set([...listedIds, ...flaggedIds])];
  const timeoutRaw = args["timeout-seconds"];
  const timeoutSeconds = typeof timeoutRaw === "number"
    ? timeoutRaw
    : typeof timeoutRaw === "string" && timeoutRaw.length > 0
    ? Number(timeoutRaw)
    : undefined;

  // Repo-wide open-issue titles (Issue #537) — the semantic second line of
  // dedup. A gh failure returns an empty list, which renders `(none)`.
  const openIssueTitles = await listAllOpenIssueTitles(repo, gh);

  const result = await scan({
    repo,
    workDir,
    suppressedIds,
    knownOpenFindingIds,
    openIssueTitles,
    ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
  });

  if (!result.ok) {
    return {
      success: false,
      message: JSON.stringify({ error: result.error }),
      data: { error: result.error },
    };
  }

  return {
    success: true,
    message: JSON.stringify(result.value),
    data: result.value,
  };
}

export const runSecurityScanCommand: Command = {
  name: "run-security-scan",
  description:
    "Drive Claude through the four-phase MythOS security audit (outcome-only — Claude files findings via gh)",

  execute(args: Record<string, unknown>, _config: WorkerConfig) {
    return executeRunSecurityScan(args);
  },
};
