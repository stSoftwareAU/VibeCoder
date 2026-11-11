/**
 * Base-merge policy for repairs and one diagnostic line per base-refresh
 * decision (Issue #4943).
 *
 * A repair (failed CI or requested review changes) merges the PR's base into
 * its branch for a genuine conflict, that is, when GitHub reports the PR as
 * `CONFLICTING`, or when a failing check already passes on the base, so the
 * base merge brings the base's fix in (Issue #4943). A behind-only PR with no
 * such check is not repaired by a base merge: the refresh that brings it up to
 * date is owned by the shared final-refresh owner from Issue #4613
 * (`requestReadyBranchUpdate`), which also serialises
 * the per-base refresh across the updater lanes. The lanes that decide through
 * `requestReadyBranchUpdate`, and the repair lanes (CI, feedback, spelling and
 * the babysitter), log one bounded line per decision through
 * {@link logBaseRefreshDecision}, so an operator can see which lane asked for a
 * refresh, which was skipped, and why. The local `updatePrBranch` conflict merge
 * (`performBranchUpdate` in the branch-update loop and pr-maintenance, and the
 * `update-pr-branch` command) logs no such line and writes no counter. The
 * review-fleet-prs script logs from its own process and writes no counter file.
 * docs/MERGE.md lists the lanes and where their counts land.
 */
import { redactSecrets } from "./secret_redaction.ts";
import {
  formatBuildBanner,
  formatBuildStamp,
  type WorkerBuildInfo,
  workerBuildInfoOnce,
} from "./worker_build_info.ts";
import { incrementCounter } from "./fault_tolerance_counters.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import {
  BRANCH_REFRESH_REFUSAL_THRESHOLD,
  type BranchRefreshRefusalEntry,
  type BranchRefreshRefusalState,
  clearBranchRefreshRefusal,
  notifyBranchRefreshRefusal,
  readBranchRefreshRefusals,
  recordBranchRefreshRefusal,
  writeBranchRefreshRefusals,
} from "./branch_refresh_refusal_streak.ts";

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
 * merge:true when mergeable === "CONFLICTING" (reason "genuine conflict:
 * GitHub reports CONFLICTING"), and also when `fixedOnBase` names at least one
 * failing check that already passes on the base (Issue #4943), so the base
 * merge brings the base's fix in. Every other value (MERGEABLE, UNKNOWN, null,
 * undefined, anything) with no such check -> merge:false with a reason naming
 * the value and saying the base merge is left to the shared final-refresh
 * owner (Issue #4613).
 */
export function decideRepairBaseMerge(
  mergeable: unknown,
  fixedOnBase?: readonly string[],
): RepairBaseMergeDecision {
  if (mergeable === "CONFLICTING") {
    return {
      merge: true,
      reason: "genuine conflict: GitHub reports CONFLICTING",
    };
  }
  if (fixedOnBase !== undefined && fixedOnBase.length > 0) {
    const names = cleanField(fixedOnBase.join(", "), FIELD_CAP);
    return {
      merge: true,
      reason:
        `failing check "${names}" passes on the base, so the base merge brings the base fix in`,
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

/** The named counter a decision increments: `baseRefresh.<outcome>.<source>`. */
export function baseRefreshCounterName(
  facts: Pick<BaseRefreshDecisionFacts, "outcome" | "source">,
): string {
  return `baseRefresh.${facts.outcome}.${cleanField(facts.source, FIELD_CAP)}`;
}

/** Where the standalone commands accumulate their decision counters. */
export const BASE_REFRESH_COUNTERS_FILE = "base_refresh_counters.json";

/**
 * Add one decision to the durable `{dir}/base_refresh_counters.json`
 * (`{ counters: { "baseRefresh.<outcome>.<source>": n } }`, cumulative). The
 * standalone CI, feedback, spelling and babysitter commands do not write the
 * worker's per-cycle `fault_tolerance_summary.json`, so this file is how an
 * automatic follow-up reads their `baseRefresh.*` totals without parsing logs.
 * Never throws: persistence must not change the refresh or repair outcome.
 */
export async function persistBaseRefreshCounter(
  dir: string | undefined,
  facts: Pick<BaseRefreshDecisionFacts, "outcome" | "source">,
): Promise<void> {
  await persistNamedCounter(dir, baseRefreshCounterName(facts));
}

/**
 * Add one to the counter called `name` in `{dir}/base_refresh_counters.json`,
 * the shared store behind {@link persistBaseRefreshCounter}. Never throws. A
 * missing file starts the tally silently; a garbled or unreadable one logs one
 * warning that the tally restarts; a failed write logs one warning naming the
 * counter and the directory.
 */
async function persistNamedCounter(
  dir: string | undefined,
  name: string,
): Promise<void> {
  if (!dir) return;
  try {
    const path = `${dir}/${BASE_REFRESH_COUNTERS_FILE}`;
    let counters: Record<string, number> = {};
    try {
      const parsed: unknown = JSON.parse(await Deno.readTextFile(path));
      const stored = (parsed as { counters?: unknown } | null)?.counters;
      if (stored && typeof stored === "object" && !Array.isArray(stored)) {
        for (const [key, count] of Object.entries(stored)) {
          if (typeof count === "number" && Number.isFinite(count)) {
            counters[key] = count;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        console.warn(
          `[base-refresh] could not read the counters in ${path}; the tally restarts: ${
            redactSecrets(
              error instanceof Error ? error.message : String(error),
            )
          }`,
        );
      }
      counters = {};
    }
    counters[name] = (counters[name] ?? 0) + 1;
    await Deno.mkdir(dir, { recursive: true });
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    await Deno.writeTextFile(
      temp,
      JSON.stringify(
        { timestamp: new Date().toISOString(), counters },
        null,
        2,
      ),
    );
    await Deno.rename(temp, path);
  } catch (error) {
    console.warn(
      `[base-refresh] could not persist the counter ${name} under ${dir}: ${
        redactSecrets(error instanceof Error ? error.message : String(error))
      }`,
    );
  }
}

/**
 * Write one diagnostic line to stderr (console.warn), so a command that prints
 * JSON on stdout stays parseable. Never throws: logging must not change the
 * outcome of the refresh or repair it describes.
 */
export function logBaseRefreshDecision(
  facts: BaseRefreshDecisionFacts,
  log: (line: string) => void = console.warn,
  stamp?: string,
): void {
  try {
    // The named counters land in the per-cycle fault-tolerance summary, so an
    // automatic follow-up can read `baseRefresh.<outcome>.<source>` totals
    // without parsing logs.
    incrementCounter(baseRefreshCounterName(facts));
    log(formatBaseRefreshDecision(facts, stamp ?? defaultStamp()));
  } catch {
    // Diagnostics are best effort; swallow so the caller's result stands.
  }
}

/**
 * The startup line that states the base-refresh policy this worker applies,
 * beside the `[worker-build]` banner. A worker that predates Issue #4943 does
 * not print it, so a stale deployed worker is visible from the log alone.
 */
export function formatBaseRefreshStartup(info: WorkerBuildInfo): string {
  return `[base-refresh] startup repair-base-merge=conflict-or-base-fixed refresh-owner=shared-per-base(#4613) transient-recovery=refusal-streak(#4831) counters=baseRefresh.<outcome>.<source> ${
    formatBuildStamp(info)
  }`;
}

/**
 * The worker's startup build lines, in print order: the `[worker-build]` banner
 * (Issue #3138) then the base-refresh policy line, both from one build stamp.
 * `commands/run_core.ts` prints exactly these, so the extension of the existing
 * startup/version diagnostics is covered by testing this function.
 */
export function formatStartupBuildLines(info: WorkerBuildInfo): string[] {
  return [formatBuildBanner(info), formatBaseRefreshStartup(info)];
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

/** Durable streak and one-comment escalation, as the sweep wires them (#4831). */
export interface RepairMergeabilityTracker {
  load: () => Promise<BranchRefreshRefusalState>;
  save: (state: BranchRefreshRefusalState) => Promise<void>;
  notify: (event: {
    repo: string;
    prNumber: number;
    entry: BranchRefreshRefusalEntry;
    active: boolean;
    lane: "repair";
  }) => Promise<void>;
}

/**
 * The production tracker: the persisted #4831 refusal state under `workDir`
 * and its single trusted diagnostic PR comment. Undefined without a work
 * directory, so nothing is persisted blind.
 */
export function createRepairMergeabilityTracker(input: {
  workDir: string | undefined;
  gh: (args: string[]) => Promise<string>;
  fleetAuthors: string[];
}): RepairMergeabilityTracker | undefined {
  const { workDir, gh, fleetAuthors } = input;
  if (!workDir) return undefined;
  return {
    load: () => readBranchRefreshRefusals(workDir),
    save: (state) => writeBranchRefreshRefusals(workDir, state),
    notify: ({ repo, prNumber, entry, active, lane }) =>
      notifyBranchRefreshRefusal(
        { repo, prNumber, entry, active, lane },
        gh,
        (login) => isFleetAuthor(login, fleetAuthors),
      ),
  };
}

/**
 * Apply the existing #4831 transient-refusal recovery to a repair's
 * mergeability read, instead of polling for GitHub to finish calculating.
 * An `UNKNOWN` read counts a consecutive refusal; at the threshold one trusted
 * comment says the refresh is waiting. A `MERGEABLE` or `CONFLICTING` read
 * clears the streak and, if the comment was posted, updates it to recovered.
 * Any other value is an inconclusive read and leaves the streak alone. When the
 * repeated-`UNKNOWN` counter fires it is also persisted to `counterDir`'s
 * `base_refresh_counters.json`, when one is given. Never throws: tracking must
 * not change the repair's outcome.
 */
export async function trackRepairMergeability(
  tracker: RepairMergeabilityTracker | undefined,
  repo: string,
  prNumber: number,
  mergeable: unknown,
  log: (line: string) => void = console.warn,
  counterDir?: string,
): Promise<void> {
  if (!tracker) return;
  try {
    if (mergeable === "UNKNOWN") {
      const state = await tracker.load();
      const entry = recordBranchRefreshRefusal(
        state,
        repo,
        prNumber,
        "mergeability-unknown",
      );
      if (
        entry.streak >= BRANCH_REFRESH_REFUSAL_THRESHOLD && !entry.notified
      ) {
        try {
          await tracker.notify({
            repo,
            prNumber,
            entry,
            active: true,
            lane: "repair",
          });
          entry.notified = true;
        } catch (error) {
          log(
            `[base-refresh] could not post the refresh-waiting comment on ${repo}#${prNumber}: ${
              redactSecrets(
                error instanceof Error ? error.message : String(error),
              )
            }`,
          );
        }
        incrementCounter("baseRefresh.repeatedMergeabilityUnknown");
        await persistNamedCounter(
          counterDir,
          "baseRefresh.repeatedMergeabilityUnknown",
        );
        log(
          `[base-refresh] fleet health: repair mergeability of ${repo}#${prNumber} still UNKNOWN after ${entry.streak} consecutive reads`,
        );
      }
      await tracker.save(state);
    } else if (mergeable === "MERGEABLE" || mergeable === "CONFLICTING") {
      const state = await tracker.load();
      const previous = clearBranchRefreshRefusal(state, repo, prNumber);
      if (!previous) return;
      if (previous.notified) {
        try {
          await tracker.notify({
            repo,
            prNumber,
            entry: previous,
            active: false,
            lane: "repair",
          });
        } catch (error) {
          log(
            `[base-refresh] could not update the refresh-waiting comment on ${repo}#${prNumber}: ${
              redactSecrets(
                error instanceof Error ? error.message : String(error),
              )
            }`,
          );
        }
      }
      await tracker.save(state);
    }
  } catch (error) {
    log(
      `[base-refresh] could not track mergeability of ${repo}#${prNumber}: ${
        redactSecrets(error instanceof Error ? error.message : String(error))
      }`,
    );
  }
}

/**
 * Read the PR's mergeability through gh, decide whether a repair may merge
 * the base, and log the decision. Never throws: an unreadable or garbled read
 * is a refusal to merge, with the redacted failure as the reason.
 *
 * The `fixedOnBase` probe (Issue #4943) is called only when the PR is not
 * `CONFLICTING`. A probe that throws counts as no failing check passing on the
 * base, and its redacted cause is appended to the skip reason.
 */
export async function readRepairBaseMergeDecision(input: {
  repo: string;
  prNumber: number;
  gh: (args: string[]) => Promise<string>;
  source: string;
  base?: string;
  log?: (line: string) => void;
  /** Applies the #4831 transient-refusal recovery to an `UNKNOWN` read. */
  tracker?: RepairMergeabilityTracker;
  /** Directory the decision counter is persisted to (standalone commands). */
  counterDir?: string;
  /** Names the failing checks that already pass on the base (Issue #4943). */
  fixedOnBase?: () => Promise<readonly string[]>;
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
    const mergeable = (parsed as Record<string, unknown>).mergeable;
    let fixedOnBase: readonly string[] = [];
    let probeNote = "";
    if (mergeable !== "CONFLICTING" && input.fixedOnBase !== undefined) {
      try {
        fixedOnBase = await input.fixedOnBase();
      } catch (error) {
        probeNote = `; base-fix check unreadable: ${
          redactSecrets(error instanceof Error ? error.message : String(error))
        }`;
      }
    }
    const verdict = decideRepairBaseMerge(mergeable, fixedOnBase);
    decision = verdict.merge
      ? verdict
      : { merge: false, reason: `${verdict.reason}${probeNote}` };
    await trackRepairMergeability(
      input.tracker,
      input.repo,
      input.prNumber,
      mergeable,
      input.log,
      input.counterDir,
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
  await persistBaseRefreshCounter(input.counterDir, {
    source: input.source,
    outcome: decision.merge ? "base-merge-allowed" : "base-merge-skipped",
  });
  return decision;
}
