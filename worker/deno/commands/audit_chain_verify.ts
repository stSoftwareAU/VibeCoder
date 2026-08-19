/**
 * Scheduled audit-chain verification (Issue #3712).
 *
 * `audit-log-tail --verify` checks one journal on operator demand, which
 * meant nothing ever ran the verification on its own. This command sweeps
 * every chain under the audit directory — including journals that have
 * been deleted but still have an anchor — and reports a loud `[SECURITY]`
 * failure when any chain or anchor does not reconcile. It runs as a
 * startup housekeeping step so every worker start re-verifies its own
 * audit trail.
 *
 * Usage:
 *   deno task audit-chain-verify
 *   deno task audit-chain-verify --base-dir /path/to/audit
 *   deno task audit-chain-verify --adopt        # bless pre-anchor journals
 *   deno task audit-chain-verify --json
 *
 * Uses Australian English throughout (behaviour, organisation, authorised).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  adoptAnchor,
  type ChainSweepEntry,
  resolveBaseDir,
  verifyAllChains,
} from "../lib/audit_journal.ts";

/** Typed data returned by the audit-chain-verify command. */
export interface AuditChainVerifyData {
  /** Audit directory swept. */
  baseDir: string;
  /** Number of chains inspected. */
  checked: number;
  /** Chains that failed verification (empty on a clean sweep). */
  broken: ChainSweepEntry[];
  /** Journals whose anchor was adopted this run (`--adopt` only). */
  adopted: string[];
}

/** Format one broken chain as a loud, greppable line. */
function formatBroken(entry: ChainSweepEntry): string {
  const at = entry.brokenIndex !== undefined
    ? ` at entry ${entry.brokenIndex}`
    : "";
  return `[SECURITY] [AUDIT_CHAIN_BROKEN] ${entry.path}${at}: ${
    entry.reason ?? "unknown reason"
  }`;
}

/**
 * Audit-chain-verify command implementation.
 */
export const auditChainVerifyCommand: Command = {
  name: "audit-chain-verify",
  description:
    "Verify every audit-journal hash chain against its anchor (Issue #3712)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<AuditChainVerifyData>> {
    const baseDirArg = args["base-dir"] as string | undefined;
    const baseDir = resolveBaseDir(baseDirArg);
    const asJson = args["json"] === true;
    const adopt = args["adopt"] === true;

    const adopted: string[] = [];
    if (adopt) {
      const first = await verifyAllChains(baseDir);
      if (!first.ok) {
        return {
          success: false,
          message:
            `[SECURITY] [AUDIT_CHAIN_BROKEN] sweep failed: ${first.error.message}`,
          data: { baseDir, checked: 0, broken: [], adopted },
        };
      }
      for (const entry of first.value.broken) {
        // Only a *missing* anchor is adoptable — a truncated, deleted, or
        // rewritten journal must stay broken (never bless tampering).
        if (!entry.reason?.includes("anchor missing")) continue;
        const result = await adoptAnchor(entry.path);
        if (result.ok) adopted.push(entry.path);
      }
    }

    const swept = await verifyAllChains(baseDir);
    if (!swept.ok) {
      return {
        success: false,
        message:
          `[SECURITY] [AUDIT_CHAIN_BROKEN] sweep failed: ${swept.error.message}`,
        data: { baseDir, checked: 0, broken: [], adopted },
      };
    }

    const { checked, broken } = swept.value;
    const data: AuditChainVerifyData = { baseDir, checked, broken, adopted };

    if (asJson) {
      return {
        success: broken.length === 0,
        message: JSON.stringify(data),
        data,
      };
    }

    const lines: string[] = [];
    for (const path of adopted) lines.push(`adopted anchor for ${path}`);
    for (const entry of broken) lines.push(formatBroken(entry));
    lines.push(
      broken.length === 0
        ? `audit chains OK: ${checked} verified in ${baseDir}`
        : `audit chains BROKEN: ${broken.length} of ${checked} failed in ${baseDir}`,
    );

    return {
      success: broken.length === 0,
      message: lines.join("\n"),
      data,
    };
  },
};
