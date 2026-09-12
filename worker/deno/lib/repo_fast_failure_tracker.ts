/**
 * Durable per-repository fast-failure tracker (Issue #1950).
 *
 * `repo_failure_tracker.ts` counts unique failing issues *within one scan
 * cycle* and `run_core.ts` clears it at the top of every cycle, so nothing
 * it records outlives the cycle — and each scheduled cycle is a fresh
 * process. A repository whose runs die in the first minute at setup was
 * therefore retried every cycle for a week: 47 sub-minute failures in one
 * week of fleet records, 12 of 14 runs in one repository.
 *
 * This module tracks the other signal — **how fast the run died** — and
 * persists it, using the same durable sidecar pattern as
 * `fleet_telemetry_sidecar.ts`:
 *
 *   {workDir}/repo_fast_failures_{host}.json
 *
 * The hostname rides in the filename, never the PID, so the counters
 * survive a worker restart (the PID-scoped `failures-<pid>` file could
 * not) while several workers sharing a work volume keep separate files.
 *
 * A *fast* failure is one that ended before the agent produced any output,
 * or inside `fastFailureSeconds` (default 60). That is a claim or setup
 * fault — a missing toolchain, a broken quality-gate bootstrap, a
 * credential or branch problem — not a property of the issue. After
 * `threshold` fast failures inside `windowSeconds` (default 3 in 24 h) the
 * repository is backed off, and the back-off decays on its own: events
 * older than the window are pruned on every read, so a repaired repository
 * recovers without an operator touching anything.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import type { FailureCategory } from "./failure_diagnosis.ts";
import { atomicWrite } from "./file_utils.ts";
import { redactedLineTail, redactedTail } from "./redacted_text.ts";
import { withStateLock } from "./state_mutex.ts";
import { getHostname } from "./worker_identity.ts";

/** Sidecar schema version — bumped when the shape changes. */
export const REPO_FAST_FAILURE_SCHEMA = 1;

/** A failure inside this many seconds is a claim/setup fault, not the issue. */
export const DEFAULT_FAST_FAILURE_SECONDS = 60;

/** Fast failures inside the window before a repository is backed off. */
export const DEFAULT_REPO_FAST_FAILURE_THRESHOLD = 3;

/** Rolling window the threshold is counted over, and the decay period. */
export const DEFAULT_REPO_FAST_FAILURE_WINDOW_HOURS = 24;

/** How long a diagnostic issue's state is cached before it is re-checked. */
export const REPO_FAST_FAILURE_DIAGNOSTIC_RECHECK_SECONDS = 600;

/** Characters of the last error line kept per recorded event. */
export const REPO_FAST_FAILURE_DETAIL_CHARS = 400;

/** Events retained per repository — the newest, for the diagnostic body. */
export const REPO_FAST_FAILURE_MAX_EVENTS = 20;

/**
 * Categories that fail fast for reasons that are not the repository's.
 *
 * A rate-limited run dies in seconds on every repository at once, and a
 * scheduled release is a deliberate handover, not a fault. Counting either
 * would back off healthy repositories for a host-wide condition.
 */
const NOT_REPO_FAULT: ReadonlySet<FailureCategory> = new Set<FailureCategory>([
  "rate_limit",
  "scheduled_release",
]);

/** One fast failure, as recorded on disk. */
export interface RepoFastFailureEvent {
  /** Epoch seconds when the run was released. */
  at: number;
  /** Phase that died. */
  phase: string;
  /** The line that says why it failed — bounded and redacted. */
  detail: string;
  /** Issue the run was claiming, when known. */
  issueNumber?: number;
  /** Wall-clock seconds from claim to release. */
  elapsedSeconds?: number;
}

/** Everything the tracker holds for one repository. */
export interface RepoFastFailureRecord {
  failures: RepoFastFailureEvent[];
  /** Repository the diagnostic issue was filed in. */
  diagnosticRepo?: string;
  /** Diagnostic issue number, once one has been filed. */
  diagnosticIssue?: number;
  /** Epoch seconds the diagnostic issue's state was last checked. */
  diagnosticCheckedAt?: number;
}

/** On-disk shape of the sidecar. */
export interface RepoFastFailureFile {
  schema: number;
  host: string;
  /** ISO timestamp of the write. */
  updatedAt: string;
  /** Keyed by `owner/repo`. */
  repos: Record<string, RepoFastFailureRecord>;
}

/** Why a sidecar could not be used. */
export type RepoFastFailureReadFault =
  | "absent"
  | "unreadable"
  | "unparseable"
  | "future-schema";

/** The resolved back-off policy. */
export interface RepoFastFailurePolicy {
  /** A failure under this many seconds counts as fast. */
  fastFailureSeconds: number;
  /** Fast failures inside the window before the repository is backed off. */
  threshold: number;
  /** Rolling window, in seconds. */
  windowSeconds: number;
}

/** Operator-supplied policy values, straight from `.config.json`. */
export interface RepoFastFailurePolicyInput {
  fastFailureSeconds?: number;
  threshold?: number;
  windowHours?: number;
}

/** A repository's current state, derived from its pruned events. */
export interface RepoFastFailureState {
  repo: string;
  /** Fast failures still inside the window. */
  count: number;
  /** Whether the repository is backed off right now. */
  backedOff: boolean;
  /** Epoch seconds the back-off lapses; absent when not backed off. */
  backedOffUntil?: number;
  /** Phase of the most recent fast failure. */
  lastPhase?: string;
  /** Diagnostic error line of the most recent fast failure. */
  lastDetail?: string;
  /** Epoch seconds of the most recent fast failure. */
  lastAt?: number;
  diagnosticRepo?: string;
  diagnosticIssue?: number;
  diagnosticCheckedAt?: number;
}

/**
 * Sanitise a hostname for safe use in a filename. Anything outside the
 * allowlist becomes `_`, so a hostname carrying a separator can never
 * escape the sidecar out of `workDir`.
 */
function sanitiseHostname(hostname: string): string {
  const cleaned = hostname.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown-host";
}

/** Path to this host's fast-failure sidecar inside `workDir`. */
export function repoFastFailurePath(
  workDir: string,
  hostname: string = getHostname(),
): string {
  return `${workDir}/repo_fast_failures_${sanitiseHostname(hostname)}.json`;
}

/** A positive finite integer, or the fallback. Config arrives untrusted. */
function positiveInt(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** Resolve the policy, guarding every operator-supplied value. */
export function resolveRepoFastFailurePolicy(
  input: RepoFastFailurePolicyInput = {},
): RepoFastFailurePolicy {
  return {
    fastFailureSeconds: positiveInt(
      input.fastFailureSeconds,
      DEFAULT_FAST_FAILURE_SECONDS,
    ),
    threshold: positiveInt(
      input.threshold,
      DEFAULT_REPO_FAST_FAILURE_THRESHOLD,
    ),
    windowSeconds: positiveInt(
      input.windowHours,
      DEFAULT_REPO_FAST_FAILURE_WINDOW_HOURS,
    ) * 3600,
  };
}

/** What the release site knows about a failed run, for classification. */
export interface FastFailureCandidate {
  category: FailureCategory;
  /** Wall-clock seconds from claim to release. */
  elapsedSeconds?: number;
}

/**
 * Whether a failed run counts as a *fast* failure for its repository.
 *
 * `zero_output` is fast whatever the clock says — the run ended before the
 * agent produced any output, which is the setup fault this tracker exists
 * to catch. Host-wide causes ({@link NOT_REPO_FAULT}) never count.
 */
export function isFastFailure(
  candidate: FastFailureCandidate,
  policy: RepoFastFailurePolicy,
): boolean {
  if (NOT_REPO_FAULT.has(candidate.category)) return false;
  if (candidate.category === "zero_output") return true;
  const elapsed = candidate.elapsedSeconds;
  if (typeof elapsed !== "number" || !Number.isFinite(elapsed)) return false;
  return elapsed < policy.fastFailureSeconds;
}

/** Trailing lines searched for the diagnostic one. */
const LAST_LINE_WINDOW = 20;

/**
 * Trailing lines that end a failure without saying what went wrong.
 *
 * git's push summary is the case that cost a diagnostic (Issue #2034):
 * `error: failed to push some refs to '<url>'` is always the last line and
 * names only the repository, so a setup phase that died on a refused push
 * filed an issue whose one piece of evidence was "a push failed". The reason
 * — `! [remote rejected] … (push declined due to repository rule violations)`
 * — sits one line above it, and is what a reader can act on.
 *
 * Deliberately narrow: each pattern matches a line that carries no diagnosis
 * at all, so skipping it can only improve what is recorded. `hint:` is on the
 * list because git's hints are advice appended *after* the rejection, and the
 * last of them ("see the note about fast-forwards") explains nothing.
 */
const UNINFORMATIVE_LINE_PATTERNS: readonly RegExp[] = [
  /^error: failed to push some refs\b/i,
  /^To\s+\S+$/, // git's destination line, printed above the rejection
  /^remote:\s*$/i, // GitHub's blank padding inside a `remote:` block
  /^hint:/i,
];

/** Whether `line` is one of the trailing lines that carries no diagnosis. */
function isUninformativeLine(line: string): boolean {
  return UNINFORMATIVE_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * The last line of a failure message that says *why* it failed, redacted and
 * bounded.
 *
 * That is the last non-empty line, except that trailing lines carrying no
 * diagnosis ({@link UNINFORMATIVE_LINE_PATTERNS}) are stepped over. When
 * every line in the window is one of those, the true last line is kept: a
 * record that says something imperfect beats one that says nothing.
 *
 * The line is filed into a public issue body and the failure message quotes
 * the agent's own output, so the message is handed to `redactedLineTail`
 * **whole** (Issue #1257) rather than having a line picked out of it first:
 * a PEM block, a multi-line base64 blob and a `--token <value>` pair all
 * span lines, and a rule that never sees the line above cannot match them.
 */
export function diagnosticErrorLine(message: string): string {
  const lines = redactedLineTail(message ?? "", LAST_LINE_WINDOW)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const informative = lines.filter((line) => !isUninformativeLine(line));
  const candidates = informative.length > 0 ? informative : lines;
  const chosen = candidates.length > 0
    ? candidates[candidates.length - 1]!
    : "";
  return redactedTail(chosen, REPO_FAST_FAILURE_DETAIL_CHARS);
}

/** Coerce an unknown record read from disk into a well-formed one. */
function parseRecord(raw: unknown): RepoFastFailureRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Partial<RepoFastFailureRecord>;
  if (!Array.isArray(candidate.failures)) return null;
  const failures: RepoFastFailureEvent[] = [];
  for (const event of candidate.failures) {
    if (typeof event !== "object" || event === null) continue;
    const e = event as Partial<RepoFastFailureEvent>;
    if (typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
    failures.push({
      at: e.at,
      phase: typeof e.phase === "string" ? e.phase : "unknown",
      detail: typeof e.detail === "string" ? e.detail : "",
      ...(typeof e.issueNumber === "number"
        ? { issueNumber: e.issueNumber }
        : {}),
      ...(typeof e.elapsedSeconds === "number"
        ? { elapsedSeconds: e.elapsedSeconds }
        : {}),
    });
  }
  return {
    failures,
    ...(typeof candidate.diagnosticRepo === "string"
      ? { diagnosticRepo: candidate.diagnosticRepo }
      : {}),
    ...(typeof candidate.diagnosticIssue === "number"
      ? { diagnosticIssue: candidate.diagnosticIssue }
      : {}),
    ...(typeof candidate.diagnosticCheckedAt === "number"
      ? { diagnosticCheckedAt: candidate.diagnosticCheckedAt }
      : {}),
  };
}

/**
 * Read the sidecar.
 *
 * A corrupt sidecar is diagnostic data, so it is replaced on the next write
 * rather than failing the run — but "absent" and "present but unusable" are
 * kept apart so a caller can say which happened instead of silently
 * restarting the host's counters.
 */
export async function readRepoFastFailureFile(
  workDir: string,
  hostname: string = getHostname(),
): Promise<RepoFastFailureFile | RepoFastFailureReadFault> {
  let raw: string;
  try {
    raw = await Deno.readTextFile(repoFastFailurePath(workDir, hostname));
  } catch (err) {
    return err instanceof Deno.errors.NotFound ? "absent" : "unreadable";
  }
  let parsed: RepoFastFailureFile;
  try {
    parsed = JSON.parse(raw) as RepoFastFailureFile;
  } catch {
    return "unparseable";
  }
  if (
    typeof parsed?.schema !== "number" ||
    typeof parsed?.repos !== "object" || parsed.repos === null
  ) {
    return "unparseable";
  }
  // A file written by a newer worker is not ours to rewrite as schema 1.
  if (parsed.schema > REPO_FAST_FAILURE_SCHEMA) return "future-schema";
  const repos: Record<string, RepoFastFailureRecord> = {};
  for (const [repo, record] of Object.entries(parsed.repos)) {
    const parsedRecord = parseRecord(record);
    if (parsedRecord) repos[repo] = parsedRecord;
  }
  return {
    schema: parsed.schema,
    host: typeof parsed.host === "string" ? parsed.host : hostname,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    repos,
  };
}

/** Narrow a {@link readRepoFastFailureFile} result to a usable file. */
export function isRepoFastFailureFile(
  result: RepoFastFailureFile | RepoFastFailureReadFault,
): result is RepoFastFailureFile {
  return typeof result !== "string";
}

/** Drop events that have decayed out of the window, newest first. */
function pruneEvents(
  events: readonly RepoFastFailureEvent[],
  nowSeconds: number,
  policy: RepoFastFailurePolicy,
): RepoFastFailureEvent[] {
  return [...events]
    .filter((event) => event.at + policy.windowSeconds > nowSeconds)
    .sort((a, b) => b.at - a.at)
    .slice(0, REPO_FAST_FAILURE_MAX_EVENTS);
}

/**
 * Decay every record: events outside the window go, and a record they leave
 * empty goes with them — diagnostic pointer included.
 *
 * Keeping a pointer alone looked tidy and was a bug. The next time the
 * repository broke, the release path would see a diagnostic already attached
 * and file nothing, and that long-closed issue would then release the fresh
 * back-off on the next scan: no diagnostic and no back-off, exactly when both
 * were wanted.
 */
function decayRecords(
  repos: Record<string, RepoFastFailureRecord>,
  nowSeconds: number,
  policy: RepoFastFailurePolicy,
): Record<string, RepoFastFailureRecord> {
  const live: Record<string, RepoFastFailureRecord> = {};
  for (const [repo, record] of Object.entries(repos)) {
    const failures = pruneEvents(record.failures, nowSeconds, policy);
    if (failures.length === 0) continue;
    live[repo] = { ...record, failures };
  }
  return live;
}

/**
 * Derive a repository's current state from its record.
 *
 * The back-off is not a stored flag: it is the count of events still inside
 * the window. That is what makes the decay automatic — a repaired
 * repository stops adding events and the count falls below the threshold on
 * its own, with no operator action and no separate expiry to keep in step.
 */
export function repoFastFailureState(
  repo: string,
  record: RepoFastFailureRecord | undefined,
  nowSeconds: number,
  policy: RepoFastFailurePolicy,
): RepoFastFailureState {
  const events = pruneEvents(record?.failures ?? [], nowSeconds, policy);
  const newest = events[0];
  const backedOff = events.length >= policy.threshold;
  // The count drops below the threshold when the threshold-th newest event
  // decays, so that is when the back-off lapses.
  const decisive = events[policy.threshold - 1];
  return {
    repo,
    count: events.length,
    backedOff,
    ...(backedOff && decisive
      ? { backedOffUntil: decisive.at + policy.windowSeconds }
      : {}),
    ...(newest ? { lastPhase: newest.phase, lastAt: newest.at } : {}),
    ...(newest && newest.detail ? { lastDetail: newest.detail } : {}),
    ...(record?.diagnosticRepo
      ? { diagnosticRepo: record.diagnosticRepo }
      : {}),
    ...(record?.diagnosticIssue !== undefined
      ? { diagnosticIssue: record.diagnosticIssue }
      : {}),
    ...(record?.diagnosticCheckedAt !== undefined
      ? { diagnosticCheckedAt: record.diagnosticCheckedAt }
      : {}),
  };
}

/** Shared options for every sidecar operation. */
export interface RepoFastFailureOptions {
  workDir: string;
  hostname?: string;
  /** Injected clock (epoch seconds). */
  nowSeconds?: () => number;
  policy?: RepoFastFailurePolicyInput;
  /**
   * Reports a sidecar that exists but could not be read. The operation
   * still proceeds from empty, but losing the host's counters is never
   * silent.
   */
  warn?: (message: string) => void;
}

/** Read the sidecar's repo map, reporting an unusable file rather than hiding it. */
async function loadRepos(
  workDir: string,
  hostname: string,
  warn?: (message: string) => void,
): Promise<Record<string, RepoFastFailureRecord>> {
  const prior = await readRepoFastFailureFile(workDir, hostname);
  if (isRepoFastFailureFile(prior)) return prior.repos;
  if (prior !== "absent") {
    warn?.(
      `Repo fast-failure sidecar at ${
        repoFastFailurePath(workDir, hostname)
      } is ${prior} — the host's fast-failure counters restart from zero.`,
    );
  }
  return {};
}

/**
 * Read-modify-write the sidecar under a per-path lock.
 *
 * Every record is pruned to the window on the way out, so decay happens on
 * any write and the file cannot grow without bound. A write failure is
 * returned, never swallowed: counters that quietly stop persisting are the
 * exact fault this module exists to remove.
 */
async function mutate<T>(
  options: RepoFastFailureOptions,
  apply: (
    repos: Record<string, RepoFastFailureRecord>,
    nowSeconds: number,
    policy: RepoFastFailurePolicy,
  ) => T,
): Promise<Result<T>> {
  const hostname = options.hostname ?? getHostname();
  const path = repoFastFailurePath(options.workDir, hostname);
  const now = (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const policy = resolveRepoFastFailurePolicy(options.policy);
  return await withStateLock(`repo-fast-failure:${path}`, async () => {
    const stored = await loadRepos(options.workDir, hostname, options.warn);
    // Decay BEFORE `apply` sees the map, so a caller reads — and returns —
    // the state the window actually holds.
    const repos = decayRecords(stored, now, policy);
    const value = apply(repos, now, policy);
    const contents: RepoFastFailureFile = {
      schema: REPO_FAST_FAILURE_SCHEMA,
      host: hostname,
      updatedAt: new Date(now * 1000).toISOString(),
      // Again after `apply`, so a mutation that leaves a record empty writes
      // nothing rather than an orphan.
      repos: decayRecords(repos, now, policy),
    };
    const written = await atomicWrite({
      targetFile: path,
      content: JSON.stringify(contents, null, 2) + "\n",
    });
    if (!written.ok) {
      return {
        ok: false,
        error: new Error(
          `Failed to write repo fast-failure state to ${path}: ${written.error.message}`,
        ),
      } as Result<T>;
    }
    return { ok: true, value } as Result<T>;
  });
}

/** A fast failure to record. */
export interface RepoFastFailureInput {
  phase: string;
  /** Raw failure message; the diagnostic line is kept, redacted and bounded. */
  message: string;
  issueNumber?: number;
  elapsedSeconds?: number;
}

/**
 * Record one fast failure for `repo` and return the repository's new state.
 *
 * The caller decides what counts as fast via {@link isFastFailure}; this
 * function records what it is given.
 */
export async function recordRepoFastFailure(
  options: RepoFastFailureOptions & {
    repo: string;
    failure: RepoFastFailureInput;
  },
): Promise<Result<RepoFastFailureState>> {
  return await mutate(options, (repos, now, policy) => {
    const record = repos[options.repo] ?? { failures: [] };
    record.failures = [...record.failures, {
      at: now,
      phase: options.failure.phase,
      detail: diagnosticErrorLine(options.failure.message),
      ...(options.failure.issueNumber !== undefined
        ? { issueNumber: options.failure.issueNumber }
        : {}),
      ...(options.failure.elapsedSeconds !== undefined
        ? { elapsedSeconds: options.failure.elapsedSeconds }
        : {}),
    }];
    repos[options.repo] = record;
    return repoFastFailureState(options.repo, record, now, policy);
  });
}

/**
 * Clear a repository's fast-failure history — a run that got somewhere.
 *
 * Returns whether anything was cleared, so a caller can log the recovery.
 */
export async function clearRepoFastFailures(
  options: RepoFastFailureOptions & { repo: string },
): Promise<Result<boolean>> {
  return await mutate(options, (repos) => {
    if (!repos[options.repo]) return false;
    delete repos[options.repo];
    return true;
  });
}

/** Attach the diagnostic issue a back-off filed, so it is filed only once. */
export async function recordRepoFastFailureDiagnostic(
  options: RepoFastFailureOptions & {
    repo: string;
    diagnosticRepo: string;
    diagnosticIssue: number;
  },
): Promise<Result<void>> {
  return await mutate(options, (repos, now) => {
    const record = repos[options.repo] ?? { failures: [] };
    record.diagnosticRepo = options.diagnosticRepo;
    record.diagnosticIssue = options.diagnosticIssue;
    record.diagnosticCheckedAt = now;
    repos[options.repo] = record;
  });
}

/** Every repository the sidecar holds, pruned to the window. */
export async function loadRepoFastFailureStates(
  options: RepoFastFailureOptions,
): Promise<RepoFastFailureState[]> {
  const hostname = options.hostname ?? getHostname();
  const now = (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const policy = resolveRepoFastFailurePolicy(options.policy);
  const repos = await loadRepos(options.workDir, hostname, options.warn);
  return Object.entries(repos)
    .map(([repo, record]) => repoFastFailureState(repo, record, now, policy))
    .filter((state) => state.count > 0)
    .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
}

/**
 * The repositories the implementation claim scan must not offer this cycle.
 *
 * Unioned into `findOldestIssue`'s `excludeRepos`; the label-driven lanes
 * are deliberately not filtered, because each removes its own label and so
 * stops itself.
 */
export async function backedOffRepos(
  options: RepoFastFailureOptions,
): Promise<Set<string>> {
  const states = await loadRepoFastFailureStates(options);
  return new Set(states.filter((s) => s.backedOff).map((s) => s.repo));
}

/** `2026-09-11T04:05Z` — minute precision is enough for a back-off. */
function formatUntil(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(
    /:\d\d\.\d+Z$/,
    "Z",
  );
}

/**
 * The cycle-summary line: what each tracked repository's state is, so an
 * operator sees "repo X: 5 fast failures, backed off until …" rather than
 * discovering the pattern in a hand-written weekly report.
 *
 * Returns `null` when no repository has a live fast failure, so a healthy
 * fleet adds no noise to the cycle summary.
 */
export function formatRepoFastFailureSummary(
  states: readonly RepoFastFailureState[],
): string | null {
  if (states.length === 0) return null;
  const parts = states.map((state) => {
    const plural = state.count === 1 ? "" : "s";
    const backOff = state.backedOff && state.backedOffUntil !== undefined
      ? `, backed off until ${formatUntil(state.backedOffUntil)}`
      : "";
    const diagnostic = state.diagnosticIssue !== undefined
      ? ` (${state.diagnosticRepo ?? "?"}#${state.diagnosticIssue})`
      : "";
    return `${state.repo}: ${state.count} fast failure${plural}${backOff}${diagnostic}`;
  });
  return `repo-fast-failures: ${parts.join("; ")}`;
}

/**
 * Clear the back-off for every repository whose diagnostic issue has been
 * closed — the fault it named was fixed, so the repository is claimable
 * again without waiting out the rest of the window.
 *
 * Only repositories that are backed off *and* carry a diagnostic issue are
 * probed, and each is re-checked at most once per `recheckSeconds`, so the
 * cost is bounded by the number of genuinely broken repositories.
 *
 * @returns The repositories whose back-off was cleared.
 */
export async function refreshRepoFastFailureBackOffs(
  options: RepoFastFailureOptions & {
    /** Resolves the issue's state; `undefined` when it cannot be read. */
    isIssueClosed: (
      repo: string,
      issueNumber: number,
    ) => Promise<boolean | undefined>;
    /** Minimum interval between probes of the same diagnostic issue. */
    recheckSeconds?: number;
    log?: (message: string) => void;
  },
): Promise<string[]> {
  const now = (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const recheck = positiveInt(
    options.recheckSeconds,
    REPO_FAST_FAILURE_DIAGNOSTIC_RECHECK_SECONDS,
  );
  const states = await loadRepoFastFailureStates(options);
  const cleared: string[] = [];
  for (const state of states) {
    if (!state.backedOff || state.diagnosticIssue === undefined) continue;
    if (
      state.diagnosticCheckedAt !== undefined &&
      now - state.diagnosticCheckedAt < recheck
    ) {
      continue;
    }
    const diagnosticRepo = state.diagnosticRepo ?? state.repo;
    let closed: boolean | undefined;
    try {
      closed = await options.isIssueClosed(
        diagnosticRepo,
        state.diagnosticIssue,
      );
    } catch (err) {
      // An unreadable issue state is not "closed": the back-off stands and
      // the reason is logged rather than swallowed into a silent release.
      options.log?.(
        `repo-fast-failures: could not read ${diagnosticRepo}#${state.diagnosticIssue} — back-off for ${state.repo} stands (${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      continue;
    }
    if (closed === true) {
      const result = await clearRepoFastFailures({
        ...options,
        repo: state.repo,
      });
      if (result.ok) {
        cleared.push(state.repo);
        options.log?.(
          `repo-fast-failures: ${state.repo} released — diagnostic ${diagnosticRepo}#${state.diagnosticIssue} is closed`,
        );
      } else {
        options.log?.(
          `repo-fast-failures: failed to release ${state.repo}: ${result.error.message}`,
        );
      }
      continue;
    }
    // Still open (or unreadable): stamp the probe so it is not repeated
    // every scan, and leave the back-off in place.
    const stamped = await mutate(
      { ...options, nowSeconds: () => now },
      (repos) => {
        const record = repos[state.repo];
        if (record) record.diagnosticCheckedAt = now;
      },
    );
    if (!stamped.ok) {
      options.log?.(
        `repo-fast-failures: failed to stamp the diagnostic probe for ${state.repo}: ${stamped.error.message}`,
      );
    }
  }
  return cleared;
}
