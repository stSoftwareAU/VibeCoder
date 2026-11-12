/**
 * Base-merge policy for repairs and one diagnostic line per base-refresh
 * decision (Issue #4943).
 *
 * A repair (failed CI or requested review changes) merges the PR's base into
 * its branch for a genuine conflict, that is, when GitHub reports the PR as
 * `CONFLICTING`, or when a failing check is proven to have failed with the
 * same signature on the PR's merge base and passed on a newer base commit
 * (Issue #4943). A green current-base check alone is not that proof. A
 * behind-only PR is refreshed by the shared final-refresh owner from Issue #4613
 * (`requestReadyBranchUpdate`), which also serialises
 * the per-base refresh across the updater lanes. The lanes that decide through
 * `requestReadyBranchUpdate`, and the repair lanes (CI, feedback, spelling and
 * the babysitter), log one bounded line per decision through
 * {@link logBaseRefreshDecision}, so an operator can see which lane asked for a
 * refresh, which was skipped, and why. The branch-update loop and
 * `pr-maintenance` also record local conflict-merge outcomes when their work
 * directory is available. The lower-level `update-pr-branch` command has no PR
 * number or repository identity to attach to a decision. See docs/MERGE.md for
 * the persisted-counter scope.
 */
import { confirmBaseFailureFixed } from "./babysitter_base_failure.ts";
import { prBaseForSync } from "./git_push.ts";
import { redactSecrets } from "./secret_redaction.ts";
import {
  formatBuildBanner,
  formatBuildStamp,
  type WorkerBuildInfo,
  workerBuildInfoOnce,
} from "./worker_build_info.ts";
import { incrementCounter } from "./fault_tolerance_counters.ts";
import { withFileLock } from "./file_lock.ts";
import { atomicWrite } from "./file_utils.ts";
import { isFleetAuthor } from "./fleet_authors.ts";
import {
  BRANCH_REFRESH_REFUSAL_THRESHOLD,
  type BranchRefreshRefusalEntry,
  type BranchRefreshRefusalState,
  clearBranchRefreshRefusal,
  notifyBranchRefreshRefusal,
  recordBranchRefreshRefusal,
  updateBranchRefreshRefusals,
  updateRefusalsThenNotify,
} from "./branch_refresh_refusal_streak.ts";

export type BaseRefreshOutcome =
  | "refresh-requested"
  | "refresh-skipped"
  | "base-merge-allowed"
  | "base-merge-skipped"
  | "base-merge-failed";

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
 * GitHub reports CONFLICTING"), and also when `provenBaseFixChecks` names a
 * failing check whose matching failure was proven on the PR merge base and
 * which now passes on a newer base commit (Issue #4943). The base merge then
 * brings the landed fix into the repair branch. Every other value (MERGEABLE,
 * UNKNOWN, null, undefined, anything) with no such check -> merge:false with a
 * reason naming the value and saying the base merge is left to the shared
 * final-refresh owner (Issue #4613).
 */
export function decideRepairBaseMerge(
  mergeable: unknown,
  provenBaseFixChecks?: readonly string[],
): RepairBaseMergeDecision {
  if (mergeable === "CONFLICTING") {
    return {
      merge: true,
      reason: "genuine conflict: GitHub reports CONFLICTING",
    };
  }
  if (provenBaseFixChecks !== undefined && provenBaseFixChecks.length > 0) {
    const names = cleanField(provenBaseFixChecks.join(", "), FIELD_CAP);
    return {
      merge: true,
      reason:
        `check "${names}" has the same failure on the PR merge base and passes on the newer base; merging brings in that fix`,
    };
  }
  return {
    merge: false,
    reason: `GitHub reports mergeable ${
      describeMergeable(mergeable)
    }, not CONFLICTING; the base merge is left to the shared final-refresh owner (Issue #4613)`,
  };
}

/** Redact before stripping control characters and quotes or capping length. */
function cleanField(value: string, cap: number): string {
  let kept = "";
  for (const ch of redactSecrets(value)) {
    const code = ch.codePointAt(0) ?? 0;
    const control = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    if (!control && !QUOTE_CHARS.has(ch)) kept += ch;
  }
  return [...kept].slice(0, cap).join("");
}

/**
 * One bounded single-line diagnostic:
 * `[base-refresh] source=<s> outcome=<o> repo=<r> pr=#<n> base=<b|none> owner=<#N/worker|none> reason="<...>" <stamp>`.
 * Every field is redacted before it is cleaned and capped, so a secret cannot
 * survive truncation as a fragment. The assembled line is redacted at the sink.
 */
export function formatBaseRefreshDecision(
  facts: BaseRefreshDecisionFacts,
  stamp: string,
): string {
  const reason = cleanField(facts.reason, REASON_CAP);
  const base = facts.base === undefined
    ? "none"
    : cleanField(facts.base, FIELD_CAP) || "none";
  const owner = facts.ownerPr === undefined
    ? "none"
    : `#${facts.ownerPr}/${
      cleanField(facts.ownerWorker ?? "unknown", FIELD_CAP)
    }`;
  return redactSecrets([
    "[base-refresh]",
    `source=${cleanField(facts.source, FIELD_CAP)}`,
    `outcome=${facts.outcome}`,
    `repo=${cleanField(facts.repo, FIELD_CAP)}`,
    `pr=#${facts.prNumber}`,
    `base=${base}`,
    `owner=${owner}`,
    `reason="${reason}"`,
    cleanField(stamp, FIELD_CAP),
  ].join(" "));
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

/** Why a counters file that parsed is still unusable, or undefined if usable. */
function malformedCountersField(parsed: unknown): string | undefined {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "the file is not a JSON object";
  }
  const stored = (parsed as { counters?: unknown }).counters;
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    return 'the "counters" field is missing or not an object';
  }
  for (const [key, count] of Object.entries(stored)) {
    if (typeof count !== "number" || !Number.isFinite(count)) {
      return `the "counters" entry ${
        JSON.stringify(cleanField(key, FIELD_CAP))
      } is not a finite number`;
    }
  }
  return undefined;
}

/**
 * The stored tally in `path`. A missing file starts the tally silently. A file
 * that cannot be read, is not JSON, or parses to the wrong shape logs one
 * redacted warning naming the cause and starts the tally again, so the cumulative
 * totals are never dropped without a trace.
 */
async function readStoredCounters(
  path: string,
): Promise<Record<string, number>> {
  let cause: string;
  try {
    const parsed: unknown = JSON.parse(await Deno.readTextFile(path));
    const malformed = malformedCountersField(parsed);
    if (malformed === undefined) {
      return { ...(parsed as { counters: Record<string, number> }).counters };
    }
    cause = malformed;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return {};
    cause = redactSecrets(
      error instanceof Error ? error.message : String(error),
    );
  }
  console.warn(
    redactSecrets(
      `[base-refresh] could not read the counters in ${path}; the tally restarts: ${cause}`,
    ),
  );
  return {};
}

/**
 * Add one to the counter called `name` in `{dir}/base_refresh_counters.json`,
 * the shared store behind {@link persistBaseRefreshCounter}. Never throws. A
 * missing file starts the tally silently; a garbled, unreadable or wrongly
 * shaped one (see {@link readStoredCounters}) logs one warning that the tally
 * restarts; a failed write logs one warning naming the counter and the
 * directory.
 */
async function persistNamedCounter(
  dir: string | undefined,
  name: string,
): Promise<void> {
  if (!dir) return;
  try {
    await Deno.mkdir(dir, { recursive: true });
    const path = `${dir}/${BASE_REFRESH_COUNTERS_FILE}`;
    await withFileLock(`${path}.lock`, async () => {
      const counters = await readStoredCounters(path);
      counters[name] = (counters[name] ?? 0) + 1;
      const written = await atomicWrite({
        targetFile: path,
        content: JSON.stringify(
          { timestamp: new Date().toISOString(), counters },
          null,
          2,
        ),
      });
      if (!written.ok) throw written.error;
    });
  } catch (error) {
    console.warn(
      redactSecrets(
        `[base-refresh] could not persist the counter ${name} under ${dir}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
}

/**
 * Write one diagnostic line to stderr (console.warn), so a command that prints
 * JSON on stdout stays parseable. Never throws: logging must not change the
 * outcome of the refresh or repair it describes. When the counter or the sink
 * throws, one redacted fallback line naming the source, repo, PR and error goes
 * to console.error, so a lost decision line is visible.
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
  } catch (error) {
    // The caller's result stands, but the lost line is never silent.
    console.error(
      redactSecrets(
        `[base-refresh] could not record the decision source=${
          cleanField(facts.source, FIELD_CAP)
        } repo=${
          cleanField(facts.repo, FIELD_CAP)
        } pr=#${facts.prNumber} outcome=${facts.outcome}: ${
          cleanField(
            error instanceof Error ? error.message : String(error),
            REASON_CAP,
          )
        }`,
      ),
    );
  }
}

/**
 * The startup line that states the base-refresh policy this worker applies,
 * beside the `[worker-build]` banner. A worker that predates Issue #4943 does
 * not print it, so a stale deployed worker is visible from the log alone.
 */
export function formatBaseRefreshStartup(info: WorkerBuildInfo): string {
  return redactSecrets(
    `[base-refresh] startup repair-base-merge=conflict-or-base-fixed refresh-owner=shared-per-base(#4613) transient-recovery=refusal-streak(#4831) counters=baseRefresh.<outcome>.<source> ${
      formatBuildStamp(info)
    }`,
  );
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
  update: (
    change: (state: BranchRefreshRefusalState) => Promise<void>,
  ) => Promise<void>;
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
    update: (change) => updateBranchRefreshRefusals(workDir, change),
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
 * clears only a mergeability-unknown streak and updates its comment to recovered.
 * A stale-parent refusal survives: mergeability alone does not validate parents,
 * but an `UNKNOWN` read still advances its streak, so it escalates as usual.
 * Any other value is an inconclusive read and leaves the streak alone. When the
 * repeated-`UNKNOWN` counter fires it is also persisted to `counterDir`'s
 * `base_refresh_counters.json`, when one is given. The refusal lock covers only
 * the read, decide and write; the comment is posted after it is released
 * ({@link updateRefusalsThenNotify}). Never throws: tracking must not change
 * the repair's outcome.
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
    let escalated = false;
    // Comments go out after the refusal lock is released (updateRefusalsThenNotify).
    await updateRefusalsThenNotify(
      tracker.update,
      (event) => tracker.notify({ ...event, lane: "repair" }),
      (state, defer) => {
        // Only the test-merge parent validation can recover a stale-parent
        // refusal, but an UNKNOWN read still counts towards its streak.
        const staleParents = state.get(`${repo}#${prNumber}`)?.reason ===
          "test-merge-parents-stale";
        if (mergeable === "UNKNOWN") {
          const entry = recordBranchRefreshRefusal(
            state,
            repo,
            prNumber,
            "mergeability-unknown",
          );
          if (
            entry.streak >= BRANCH_REFRESH_REFUSAL_THRESHOLD && !entry.notified
          ) {
            defer({
              event: { repo, prNumber, entry, active: true, lane: "repair" },
              onFailed: (error) =>
                log(
                  redactSecrets(
                    `[base-refresh] could not post the refresh-waiting comment on ${repo}#${prNumber}: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  ),
                ),
            });
            incrementCounter("baseRefresh.repeatedMergeabilityUnknown");
            escalated = true;
            log(
              redactSecrets(
                `[base-refresh] fleet health: repair mergeability of ${repo}#${prNumber} still UNKNOWN after ${entry.streak} consecutive reads`,
              ),
            );
          }
        } else if (
          !staleParents &&
          (mergeable === "MERGEABLE" || mergeable === "CONFLICTING")
        ) {
          const previous = clearBranchRefreshRefusal(state, repo, prNumber);
          if (previous?.notified) {
            defer({
              event: {
                repo,
                prNumber,
                entry: previous,
                active: false,
                lane: "repair",
              },
              onFailed: (error) =>
                log(
                  redactSecrets(
                    `[base-refresh] could not update the refresh-waiting comment on ${repo}#${prNumber}: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  ),
                ),
            });
          }
        }
        return Promise.resolve();
      },
    );
    if (escalated) {
      await persistNamedCounter(
        counterDir,
        "baseRefresh.repeatedMergeabilityUnknown",
      );
    }
  } catch (error) {
    log(
      redactSecrets(
        `[base-refresh] could not track mergeability of ${repo}#${prNumber}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
}

/**
 * Read the PR's mergeability through gh, decide whether a repair may merge
 * the base, and log the decision. Never throws: an unreadable or garbled read
 * is a refusal to merge, with the redacted failure as the reason.
 *
 * The `provenBaseFixChecks` probe (Issue #4943) runs only when the PR is
 * `MERGEABLE`. A probe that throws counts as no proven base fix, and its
 * redacted cause is appended to the skip reason.
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
  /** Names checks proven red on merge base and green on a newer base. */
  provenBaseFixChecks?: () => Promise<readonly string[]>;
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
    let provenBaseFixChecks: readonly string[] = [];
    let probeNote = "";
    if (
      mergeable === "MERGEABLE" && input.provenBaseFixChecks !== undefined
    ) {
      try {
        provenBaseFixChecks = await input.provenBaseFixChecks();
      } catch (error) {
        probeNote = `; base-fix check unreadable: ${
          redactSecrets(error instanceof Error ? error.message : String(error))
        }`;
      }
    }
    const verdict = decideRepairBaseMerge(mergeable, provenBaseFixChecks);
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

/** Re-read mergeability before publication, including direct library callers. */
export async function repairBaseForPublication(input: {
  repo: string;
  prNumber: number;
  knownBase?: string;
  source: string;
  gh: (args: string[]) => Promise<string>;
  warn: (message: string) => void;
  log: (message: string) => void;
  failedCheck?: { id: string; name: string };
  /**
   * Directory the `<source>-publication` decision counter is persisted to: the
   * command's work directory. Without it the decision is counted in memory only
   * and is lost when the process exits.
   */
  counterDir?: string;
}): Promise<string | undefined> {
  const base = await prBaseForSync(
    input.knownBase,
    input.repo,
    input.prNumber,
    input.gh,
    input.warn,
  );
  if (base === undefined) return undefined;
  const decision = await readRepairBaseMergeDecision({
    repo: input.repo,
    prNumber: input.prNumber,
    source: `${input.source}-publication`,
    base,
    gh: input.gh,
    log: input.log,
    counterDir: input.counterDir,
    ...(input.failedCheck === undefined ? {} : {
      provenBaseFixChecks: async () => {
        const head = JSON.parse(
          await input.gh([
            "pr",
            "view",
            String(input.prNumber),
            "--repo",
            input.repo,
            "--json",
            "headRefOid",
          ]),
        ) as { headRefOid?: unknown };
        if (typeof head.headRefOid !== "string") {
          throw new Error("PR head SHA is missing from gh pr view");
        }
        const check = input.failedCheck!;
        const proof = await confirmBaseFailureFixed({
          repo: input.repo,
          baseRef: base,
          headSha: head.headRefOid,
          checkRunId: check.id,
          checkName: check.name,
          ghFn: input.gh,
        });
        if (!proof.confirmed) throw new Error(proof.reason);
        return [check.name];
      },
    }),
  });
  return decision.merge ? base : undefined;
}
