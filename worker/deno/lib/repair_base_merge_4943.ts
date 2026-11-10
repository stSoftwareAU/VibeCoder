/**
 * Base-merge policy for repairs and one diagnostic line per base-refresh
 * decision (Issue #4943).
 *
 * A repair (failed CI or requested review changes) merges the PR's base into
 * its branch only for a genuine conflict, that is, when GitHub reports the PR
 * as `CONFLICTING`. A behind-only PR is not repaired by a base merge: the
 * refresh that brings it up to date is owned by the shared final-refresh
 * owner from Issue #4613 (`requestReadyBranchUpdate`), which also serialises
 * the per-base refresh across the updater lanes. Every base-refresh lane logs
 * one bounded line per decision through {@link logBaseRefreshDecision} so an
 * operator can see which lane asked for a refresh, which was skipped, and why.
 */
import { redactSecrets } from "./secret_redaction.ts";
import { formatBuildStamp, workerBuildInfoOnce } from "./worker_build_info.ts";

export type BaseRefreshOutcome =
  | "refresh-requested"
  | "refresh-skipped"
  | "base-merge-allowed"
  | "base-merge-skipped";

export interface BaseRefreshDecisionFacts {
  source: string;
  outcome: BaseRefreshOutcome;
  repo: string;
  prNumber: number;
  base?: string;
  reason: string;
  ownerPr?: number;
  ownerWorker?: string;
}

export interface RepairBaseMergeDecision {
  merge: boolean;
  reason: string;
}

const REASON_CAP = 200;
const FIELD_CAP = 80;
const QUOTE_CHARS = new Set(['"', "'", "`"]);

/** Describe a mergeable value for the reason without trusting its shape. */
function describeMergeable(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value).slice(0, 80);
  return `a non-string value (${typeof value})`;
}

/**
 * merge:true only when mergeable === "CONFLICTING" (reason "genuine conflict:
 * GitHub reports CONFLICTING"); every other value (MERGEABLE, UNKNOWN, null,
 * undefined, anything) -> merge:false with a reason naming the value and
 * saying the base merge is left to the shared final-refresh owner (Issue #4613).
 */
export function decideRepairBaseMerge(
  mergeable: unknown,
): RepairBaseMergeDecision {
  if (mergeable === "CONFLICTING") {
    return {
      merge: true,
      reason: "genuine conflict: GitHub reports CONFLICTING",
    };
  }
  return {
    merge: false,
    reason: `GitHub reports mergeable ${
      describeMergeable(mergeable)
    }, not CONFLICTING; the base merge is left to the shared final-refresh owner (Issue #4613)`,
  };
}

/** Strip control characters, newlines and quotes, then cap the length. */
function cleanField(value: string, cap: number): string {
  let kept = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!control && !QUOTE_CHARS.has(ch)) kept += ch;
  }
  return [...kept].slice(0, cap).join("");
}

/**
 * One bounded single-line diagnostic:
 * `[base-refresh] source=<s> outcome=<o> repo=<r> pr=#<n> base=<b|none> owner=<#N/worker|none> reason="<...>" <stamp>`.
 * The reason is redacted before it is cleaned and capped, so a secret cannot
 * survive truncation as a fragment.
 */
export function formatBaseRefreshDecision(
  facts: BaseRefreshDecisionFacts,
  stamp: string,
): string {
  const reason = cleanField(redactSecrets(facts.reason), REASON_CAP);
  const base = facts.base === undefined
    ? "none"
    : cleanField(facts.base, FIELD_CAP) || "none";
  const owner = facts.ownerPr === undefined
    ? "none"
    : `#${facts.ownerPr}/${
      cleanField(facts.ownerWorker ?? "unknown", FIELD_CAP)
    }`;
  return [
    "[base-refresh]",
    `source=${cleanField(facts.source, FIELD_CAP)}`,
    `outcome=${facts.outcome}`,
    `repo=${cleanField(facts.repo, FIELD_CAP)}`,
    `pr=#${facts.prNumber}`,
    `base=${base}`,
    `owner=${owner}`,
    `reason="${reason}"`,
    cleanField(stamp, FIELD_CAP),
  ].join(" ");
}

function defaultStamp(): string {
  try {
    return formatBuildStamp(workerBuildInfoOnce());
  } catch {
    return "build=unknown";
  }
}

/**
 * Write one diagnostic line. Never throws: logging must not change the
 * outcome of the refresh or repair it describes.
 */
export function logBaseRefreshDecision(
  facts: BaseRefreshDecisionFacts,
  log: (line: string) => void = console.log,
  stamp?: string,
): void {
  try {
    log(formatBaseRefreshDecision(facts, stamp ?? defaultStamp()));
  } catch {
    // Diagnostics are best effort; swallow so the caller's result stands.
  }
}

const OWNER_MESSAGE =
  /^base refresh owned by [\w.-]+\/[\w.-]+#(\d+) \(([^()\r\n]+)\)$/;

/**
 * Parse "base refresh owned by <owner/repo>#<n> (<worker>)" (the message
 * acquireBaseRefreshOwner's caller in required_branch_checks_4613.ts builds);
 * null when not matching.
 */
export function parseRefreshOwner(
  message: string,
): { ownerPr: number; ownerWorker: string } | null {
  const match = OWNER_MESSAGE.exec(message);
  if (!match) return null;
  const ownerPr = Number(match[1]);
  if (!Number.isInteger(ownerPr) || ownerPr <= 0) return null;
  return { ownerPr, ownerWorker: match[2]! };
}

/**
 * Read the PR's mergeability through gh, decide whether a repair may merge
 * the base, and log the decision. Never throws: an unreadable or garbled read
 * is a refusal to merge, with the redacted failure as the reason.
 */
export async function readRepairBaseMergeDecision(input: {
  repo: string;
  prNumber: number;
  gh: (args: string[]) => Promise<string>;
  source: string;
  base?: string;
  log?: (line: string) => void;
}): Promise<RepairBaseMergeDecision> {
  let decision: RepairBaseMergeDecision;
  try {
    const raw = await input.gh([
      "pr",
      "view",
      String(input.prNumber),
      "--repo",
      input.repo,
      "--json",
      "mergeable",
    ]);
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
      throw new Error("gh pr view returned no JSON object");
    }
    decision = decideRepairBaseMerge(
      (parsed as Record<string, unknown>).mergeable,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    decision = {
      merge: false,
      reason: `mergeability unreadable: ${redactSecrets(message)}`,
    };
  }
  logBaseRefreshDecision(
    {
      source: input.source,
      outcome: decision.merge ? "base-merge-allowed" : "base-merge-skipped",
      repo: input.repo,
      prNumber: input.prNumber,
      base: input.base,
      reason: decision.reason,
    },
    input.log,
  );
  return decision;
}
