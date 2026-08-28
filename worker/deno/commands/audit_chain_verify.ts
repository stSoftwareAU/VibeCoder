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
 *   deno task audit-chain-verify --acknowledge-loss <journal>[,<journal>]
 *       --reason "<why it is gone>" [--by <operator>]
 *   deno task audit-chain-verify --acknowledge-damage <journal>[,<journal>]
 *       --reason "<why it is accounted for>" [--by <operator>]
 *   deno task audit-chain-verify --json
 *
 * Uses Australian English throughout (behaviour, organisation, authorised).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  type AcknowledgedLoss,
  acknowledgeJournalDamage,
  acknowledgeJournalLoss,
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
  /** Losses already signed for — reported, but not failures (Issue #359). */
  acknowledged: AcknowledgedLoss[];
  /** Losses signed for by this run (`--acknowledge-loss` only). */
  newlyAcknowledged: string[];
}

/**
 * Is this breakage an absent journal, rather than one that fails to verify?
 *
 * Only an absent journal can be signed for. A journal that is present but
 * truncated, rewritten, or hash-broken must keep failing — acknowledging
 * one of those would be blessing tampering, which is exactly what the
 * `--adopt` guard has always refused to do.
 */
function isAcknowledgeableLoss(entry: ChainSweepEntry): boolean {
  const reason = entry.reason ?? "";
  return reason.includes("directory deleted") ||
    reason.includes("pair deleted");
}

/**
 * Has a damage signature already been given for this journal and then
 * stopped applying?
 *
 * Such an entry must not be offered `--acknowledge-damage` as if it were
 * fresh: the operator already signed, and the file changed underneath the
 * signature. Re-signing is a decision to be made deliberately, not a
 * remedy suggested by the alarm.
 */
function hasLapsedDamageSignature(entry: ChainSweepEntry): boolean {
  return (entry.reason ?? "").includes("no longer applies");
}

/** Format one broken chain as a loud, greppable line. */
function formatBroken(entry: ChainSweepEntry): string {
  const at = entry.brokenIndex !== undefined
    ? ` at entry ${entry.brokenIndex}`
    : "";
  // Issue #359: a loss that *can* be signed for says so on the line itself.
  // The operator who meets this alarm should not have to go and find out
  // that a resolution exists — the previous behaviour was an alarm with no
  // documented exit but hand-editing the tamper-evidence file.
  // Issue #491: a journal that is present but does not verify has its own
  // exit now. Naming the right one matters — pointing a corrupt journal at
  // `--acknowledge-loss` sends the operator to a command that refuses it.
  let remedy = "";
  if (isAcknowledgeableLoss(entry)) {
    remedy = ` — if this loss is accounted for, sign for it with ` +
      `\`deno task audit-chain-verify --acknowledge-loss ` +
      `${basename(entry.path)} --reason "<why>"\``;
  } else if (!hasLapsedDamageSignature(entry)) {
    remedy = ` — if this damage is accounted for, sign for it with ` +
      `\`deno task audit-chain-verify --acknowledge-damage ` +
      `${basename(entry.path)} --reason "<why>"\`; the journal is left ` +
      `exactly as it is`;
  }
  return `[SECURITY] [AUDIT_CHAIN_BROKEN] ${entry.path}${at}: ${
    entry.reason ?? "unknown reason"
  }${remedy}`;
}

/**
 * Format one accounted-for finding — reported on every sweep, never a
 * failure. The tag says which admission it is: a journal that is gone is
 * not the same finding as one that is corrupt (Issue #491).
 */
function formatAcknowledged(loss: AcknowledgedLoss): string {
  const { by, acknowledgedAt, reason } = loss.acknowledgement;
  const tag = loss.kind === "damage"
    ? "AUDIT_CHAIN_DAMAGE_ACKNOWLEDGED"
    : "AUDIT_CHAIN_LOSS_ACKNOWLEDGED";
  return `[${tag}] ${loss.path}: signed for by ${by} on ${acknowledgedAt} ` +
    `— ${reason}`;
}

/** Basename of a path. */
function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Split a comma-separated CLI list into non-empty, trimmed values. */
function splitList(value: string): string[] {
  return value.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
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
    // `parseArgs` yields `true` for a valueless flag and JSON-parses values,
    // so a bare `--acknowledge-loss` or a numeric-looking `--reason 2026`
    // arrives as a non-string. Normalise rather than trusting the cast.
    const lossArg = asText(args["acknowledge-loss"]);
    const damageArg = asText(args["acknowledge-damage"]);
    const reason = asText(args["reason"]) ?? "";
    const by = asText(args["by"]) ?? resolveOperator();

    const adopted: string[] = [];
    const newlyAcknowledged: string[] = [];
    const empty = () => ({
      baseDir,
      checked: 0,
      broken: [],
      adopted,
      acknowledged: [],
      newlyAcknowledged,
    });

    if (adopt) {
      const first = await verifyAllChains(baseDir);
      if (!first.ok) {
        return {
          success: false,
          message:
            `[SECURITY] [AUDIT_CHAIN_BROKEN] sweep failed: ${first.error.message}`,
          data: empty(),
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

    // Issue #359: sign for losses that have been accounted for. Refusals are
    // returned rather than skipped — an acknowledgement the operator asked
    // for and did not get must never pass quietly as success.
    if (lossArg !== undefined) {
      const requested = splitList(lossArg);
      if (requested.length === 0) {
        return {
          success: false,
          message: `--acknowledge-loss needs at least one journal name`,
          data: empty(),
        };
      }
      if (reason.trim().length === 0) {
        return {
          success: false,
          message:
            `--acknowledge-loss needs --reason "<why the journal is gone>" — ` +
            `an unexplained loss stays loud`,
          data: empty(),
        };
      }
      const refusals: string[] = [];
      for (const journalName of requested) {
        const signed = await acknowledgeJournalLoss({
          baseDir,
          journalName: basename(journalName),
          reason,
          by,
        });
        if (signed.ok) newlyAcknowledged.push(signed.value.journal);
        else refusals.push(signed.error.message);
      }
      if (refusals.length > 0) {
        return {
          success: false,
          message: refusals
            .map((r) => `[AUDIT_CHAIN_LOSS_NOT_ACKNOWLEDGED] ${r}`)
            .join("\n"),
          data: empty(),
        };
      }
    }

    // Issue #491: sign for damage to a journal that is still on disk. Same
    // shape as the loss path above, and just as unforgiving: refusals are
    // returned, never skipped.
    if (damageArg !== undefined) {
      const requested = splitList(damageArg);
      if (requested.length === 0) {
        return {
          success: false,
          message: `--acknowledge-damage needs at least one journal name`,
          data: empty(),
        };
      }
      if (reason.trim().length === 0) {
        return {
          success: false,
          message: `--acknowledge-damage needs --reason "<why the damage is ` +
            `accounted for>" — unexplained damage stays loud`,
          data: empty(),
        };
      }
      const refusals: string[] = [];
      for (const journalName of requested) {
        const signed = await acknowledgeJournalDamage({
          baseDir,
          journalName: basename(journalName),
          reason,
          by,
        });
        if (signed.ok) newlyAcknowledged.push(signed.value.journal);
        else refusals.push(signed.error.message);
      }
      if (refusals.length > 0) {
        return {
          success: false,
          message: refusals
            .map((r) => `[AUDIT_CHAIN_DAMAGE_NOT_ACKNOWLEDGED] ${r}`)
            .join("\n"),
          data: empty(),
        };
      }
    }

    const swept = await verifyAllChains(baseDir);
    if (!swept.ok) {
      return {
        success: false,
        message:
          `[SECURITY] [AUDIT_CHAIN_BROKEN] sweep failed: ${swept.error.message}`,
        data: empty(),
      };
    }

    const { checked, broken, acknowledged } = swept.value;
    const data: AuditChainVerifyData = {
      baseDir,
      checked,
      broken,
      adopted,
      acknowledged,
      newlyAcknowledged,
    };

    if (asJson) {
      return {
        success: broken.length === 0,
        message: JSON.stringify(data),
        data,
      };
    }

    const lines: string[] = [];
    for (const path of adopted) lines.push(`adopted anchor for ${path}`);
    for (const name of newlyAcknowledged) {
      lines.push(`acknowledged ${name} (recorded in the chain)`);
    }
    for (const loss of acknowledged) lines.push(formatAcknowledged(loss));
    for (const entry of broken) lines.push(formatBroken(entry));
    // Named in the summary too. A count that read "12 verified" while
    // three of them were known-gone or known-corrupt would be the same
    // quiet reassurance this whole subsystem exists to refuse.
    const lost = acknowledged.filter((a) => a.kind === "loss").length;
    const damaged = acknowledged.filter((a) => a.kind === "damage").length;
    const parts: string[] = [];
    if (lost > 0) parts.push(`${lost} acknowledged as lost`);
    if (damaged > 0) parts.push(`${damaged} acknowledged as damaged`);
    const signedFor = parts.length > 0 ? `, ${parts.join(", ")}` : "";
    lines.push(
      broken.length === 0
        ? `audit chains OK: ${checked} verified in ${baseDir}${signedFor}`
        : `audit chains BROKEN: ${broken.length} of ${checked} failed in ` +
          `${baseDir}${signedFor}`,
    );

    return {
      success: broken.length === 0,
      message: lines.join("\n"),
      data,
    };
  },
};

/** A CLI value as text, or undefined when the flag carried no value. */
function asText(value: unknown): string | undefined {
  if (value === undefined || value === true || value === null) return undefined;
  return String(value);
}

/** Who is signing, when `--by` is not given. */
function resolveOperator(): string {
  return Deno.env.get("VIBE_OPERATOR") ?? Deno.env.get("USER") ??
    Deno.env.get("WORKER_UNIQUE_ID") ?? "unknown-operator";
}
