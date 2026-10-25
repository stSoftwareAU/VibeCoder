/**
 * Report hard-killed runs on the next worker start (Issue #4254, piece A).
 *
 * #4253 writes `hard-kill-<container>-<epoch>.json` into the host log
 * directory before the launcher watchdog reaps a wedged container. The run
 * never releases its claim itself, so nothing else would tell the fleet the
 * kill happened. On the next start this module:
 *
 * - parses each evidence file strictly (a malformed file is kept, logged by
 *   field name, and never defaulted);
 * - derives a signature (handler, phase) and files ONE deduplicated issue in
 *   {@link RUN_FAILURE_TARGET_REPO} per signature, or adds one follow-up
 *   comment per window on the open one, reusing the run-failure machinery;
 * - fires the `failure` run callback once per file with failureClass
 *   `hard_kill`, and counts the kill as a failure. The one exception is a file
 *   that cannot be archived after the report: it stays, and the next start
 *   reports the kill again;
 * - keeps the file whenever filing fails, so the next start retries it;
 * - archives a reported file under {@link HARD_KILL_ARCHIVE_DIR} on the host.
 *
 * The issue lands in a public repository, and the killed run may have been
 * working a private one. So the issue carries only the facts the worker and
 * launcher wrote themselves (host, container, run, signature, trigger, reason,
 * times). The log, transcript, boot and guest text, the last log line, the
 * last tool call and the source repository stay in the archived file on the
 * host (Issue #4315 review; SECURITY.md incident response). Every value that
 * is posted is still redacted, bounded and made safe for an issue body.
 * Every GitHub and file call is wrapped: nothing here throws into the
 * worker's start-up path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { neutraliseCommentDelimiters } from "./agent_marker_neutralisation.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { guardedLabelArgs } from "./guarded_issue_labels.ts";
import {
  HARD_KILL_EVIDENCE_VERSION,
  type HardKillEvidence,
} from "./hard_kill_evidence.ts";
import {
  DEFAULT_TRANSCRIPT_HARD_CAP_COUNT,
  DEFAULT_TRANSCRIPT_MAX_AGE_DAYS,
} from "./worker_log_cleanup.ts";
import { redactedTail } from "./redacted_text.ts";
import type { TerminalIssueRun } from "./run_callbacks.ts";
import {
  createRunFailureIssue,
  findOpenRunFailureIssue,
  formatRunFailureMarker,
  postRunFailureFollowUp,
  RUN_FAILURE_FOLLOWUP_WINDOW_SECONDS,
  RUN_FAILURE_TARGET_REPO,
} from "./run_failure_issue.ts";
import type { SelfDiagnosticFiling } from "./self_diagnostic_attestation.ts";

/** The callback `failureClass` and the fleet failure class of a hard kill. */
export const HARD_KILL_FAILURE_CLASS = "hard_kill";
/** Evidence file name: `hard-kill-<container>-<epoch>.json` (Issue #4253). */
export const HARD_KILL_FILE_PATTERN = /^hard-kill-.+\.json$/;
/** The `runId` the evidence writes when the run was not known. */
const UNKNOWN_RUN_ID = "unknown";
/** Where a reported evidence file is kept, inside the evidence directory. */
export const HARD_KILL_ARCHIVE_DIR = "hard-kill-archive";
/**
 * A phase name the public signature may carry: a lower-case identifier, as
 * every phase the worker logs is. Log text is untrusted, so anything else is
 * `unknown`. A shape rather than a list, so a new phase keeps its name with
 * nothing to register (Issue #4315 review).
 */
const PHASE_NAME = /^[a-z][a-z0-9_]{0,39}$/;

/** Fixed public explanations; never publish the evidence file's free text. */
function publicReason(trigger: string): string {
  return trigger === "watchdog"
    ? "The launcher's watchdog deadline expired."
    : "The pre-launch scan reaped a stale container.";
}

/** Cap on text scanned for an `owner/repo#N` reference (ReDoS guard). */
const SOURCE_SCAN_CHARS = 4000;
/** Attribution for the attestation and the filing decision. */
const FILED_BY = "worker/deno/lib/hard_kill_report.ts";
/** Phase-bearing forms the worker log uses (Issue #4254 piece A). */
const PHASE_PATTERNS: readonly RegExp[] = [
  /\[phase\]\s*([A-Za-z0-9_-]+)/,
  /\bphase=([A-Za-z0-9_-]+)/,
  /\[agent-progress\]\s*([A-Za-z0-9_-]+):/,
];
/**
 * `owner/repo#N`. Owner and repo draw from the same class, so a run of name
 * characters can start a match at several positions. The cost is bounded by
 * the scan cap in {@link lastSourceIn}: at most SOURCE_SCAN_CHARS characters
 * are scanned, so one call takes O(SOURCE_SCAN_CHARS²) steps at worst.
 */
const SOURCE_PATTERN = /\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\b/g;

/** The fields a hard-kill signature is built from. */
export interface HardKillSignature {
  /** The evidence `trigger`, slugged: `watchdog` or `pre-launch`. */
  handler: string;
  /** The phase the worker log names last, slugged; `unknown` when none. */
  phase: string;
  /** `hard-kill-<handler>-<phase>`; the dedup key (marker class). */
  failureClass: string;
}

/** Where the killed run was working, from the evidence log lines. */
export interface HardKillSource {
  /** `owner/repo`, or `unknown`. */
  repo: string;
  /** Issue number, or 0 when unknown. */
  issueNumber: number;
}

/** What {@link fileHardKillIssue} did with one evidence file. */
export type HardKillFilingResult =
  | { action: "filed"; issueNumber: number }
  | { action: "commented"; issueNumber: number; updated: boolean }
  | { action: "failed"; cause: string };

/** Counts from one {@link reportPendingHardKills} pass. */
export interface HardKillReportSummary {
  found: number;
  reported: number;
  kept: number;
}

/** Filesystem seams, so a test never touches the host's log directory. */
export interface HardKillSeams {
  /** Names (not paths) of the evidence files in `dir`. */
  listEvidenceFiles(dir: string): Promise<string[]>;
  readTextFile(path: string): Promise<string>;
  /** Move a reported file into {@link HARD_KILL_ARCHIVE_DIR}. */
  archiveFile(path: string): Promise<void>;
  /** Remove expired archives and the oldest files above the transcript cap. */
  pruneArchive(dir: string, nowMs: number): Promise<void>;
}

/** Production filesystem seams. */
export const defaultHardKillSeams: HardKillSeams = {
  async listEvidenceFiles(dir: string): Promise<string[]> {
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile && HARD_KILL_FILE_PATTERN.test(entry.name)) {
        names.push(entry.name);
      }
    }
    return names;
  },
  readTextFile: (path: string) => Deno.readTextFile(path),
  async pruneArchive(dir: string, nowMs: number): Promise<void> {
    const archive = `${dir}/${HARD_KILL_ARCHIVE_DIR}`;
    try {
      if (!(await Deno.lstat(archive)).isDirectory) {
        throw new Error("hard-kill archive is not a plain directory");
      }
    } catch (err) {
      if (isNotFound(err)) return;
      throw err;
    }
    const entries: { path: string; mtimeMs: number }[] = [];
    for await (const entry of Deno.readDir(archive)) {
      if (!entry.isFile || !HARD_KILL_FILE_PATTERN.test(entry.name)) continue;
      const path = `${archive}/${entry.name}`;
      const stat = await Deno.lstat(path);
      if (stat.isFile) {
        entries.push({ path, mtimeMs: stat.mtime?.getTime() ?? nowMs });
      }
    }
    entries.sort((a, b) =>
      b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path)
    );
    for (const [i, entry] of entries.entries()) {
      if (
        nowMs - entry.mtimeMs > DEFAULT_TRANSCRIPT_MAX_AGE_DAYS * 86400_000 ||
        i >= DEFAULT_TRANSCRIPT_HARD_CAP_COUNT
      ) {
        await Deno.remove(entry.path);
      }
    }
  },
  async archiveFile(path: string): Promise<void> {
    const cut = path.lastIndexOf("/");
    const archive = `${path.slice(0, cut)}/${HARD_KILL_ARCHIVE_DIR}`;
    await Deno.mkdir(archive, { recursive: true });
    if (!(await Deno.lstat(archive)).isDirectory) {
      throw new Error("hard-kill archive is not a plain directory");
    }
    await Deno.rename(path, `${archive}/${path.slice(cut + 1)}`);
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  return err instanceof Deno.errors.NotFound ||
    (err instanceof Error && err.name === "NotFound");
}

/**
 * Redact, bound, then make safe for an issue body: comment delimiters
 * neutralised and every code fence turned into a plain quote.
 */
function safeText(text: string, maxChars: number): string {
  return neutraliseCommentDelimiters(redactedTail(text, maxChars)).replace(
    /```/g,
    "'''",
  );
}

/** A single-line value: {@link safeText}, flattened, with no backticks. */
function inlineText(text: string, maxChars: number): string {
  return safeText(text, maxChars)
    .replace(/[\r\n]+/g, " ")
    .replace(/`/g, "'")
    .trim();
}

/** Slug a signature part to `[a-z0-9-]`, capped; empty becomes `unknown`. */
function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return cleaned === "" ? "unknown" : cleaned;
}

/** Strictly parse an evidence file; throws naming the bad or missing field. */
export function parseHardKillEvidence(text: string): HardKillEvidence {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`hard-kill evidence is not JSON: ${errorText(err)}`);
  }
  if (!isRecord(raw)) {
    throw new Error("hard-kill evidence is not a JSON object");
  }
  if (raw.version !== HARD_KILL_EVIDENCE_VERSION) {
    throw new Error(
      `hard-kill evidence version ${
        String(raw.version)
      } is not ${HARD_KILL_EVIDENCE_VERSION}`,
    );
  }
  const str = (source: Record<string, unknown>, key: string): string => {
    const value = source[key];
    if (typeof value !== "string") {
      throw new Error(
        `hard-kill evidence field "${key}" is missing or not a string`,
      );
    }
    return value;
  };
  const obj = (source: Record<string, unknown>, key: string) => {
    const value = source[key];
    if (!isRecord(value)) {
      throw new Error(
        `hard-kill evidence field "${key}" is missing or not an object`,
      );
    }
    return value;
  };
  const evidence = obj(raw, "evidence");
  const guest = obj(evidence, "guest");
  const capturedAt = str(raw, "capturedAt");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(capturedAt) ||
    Number.isNaN(Date.parse(capturedAt))
  ) {
    throw new Error(
      `hard-kill evidence field "capturedAt" is not an ISO-8601 time`,
    );
  }
  const fact = (key: string, pattern: RegExp): string => {
    const value = str(raw, key);
    if (!pattern.test(value)) {
      throw new Error(`hard-kill evidence field "${key}" has an invalid shape`);
    }
    return value;
  };
  const host = fact("host", /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/);
  const container = fact("container", /^vibe-coder-[A-Za-z0-9_.-]{1,53}$/);
  const runId = fact("runId", /^(?:unknown|vibe-[0-9a-z]{1,32}-[0-9a-f]{6})$/);
  const trigger = fact("trigger", /^(?:watchdog|pre_launch)$/);
  fact(
    "reason",
    trigger === "watchdog"
      ? /^the launcher's (?:[0-9]{1,10}s )?watchdog deadline expired$/
      : /^pre-launch scan found (?:no live launcher process for it|it [0-9]{1,10}s old, past the [0-9]{1,10}s deadline)$/,
  );
  const lastLogTimestamp = fact(
    "lastLogTimestamp",
    /^(?:unknown|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z?(?: \(log file modified time; the last line carries no timestamp\))?)$/,
  );
  if (
    lastLogTimestamp !== "unknown" &&
    Number.isNaN(
      Date.parse(lastLogTimestamp.split(" (", 1)[0]!.replace(" ", "T")),
    )
  ) {
    throw new Error(
      'hard-kill evidence field "lastLogTimestamp" is not a timestamp',
    );
  }
  return {
    version: HARD_KILL_EVIDENCE_VERSION,
    capturedAt,
    host,
    container,
    runId,
    trigger,
    reason: str(raw, "reason"),
    lastLogLine: str(raw, "lastLogLine"),
    lastLogTimestamp,
    lastToolCall: str(raw, "lastToolCall"),
    evidence: {
      workerLogTail: str(evidence, "workerLogTail"),
      agentTranscriptTail: str(evidence, "agentTranscriptTail"),
      bootLogs: str(evidence, "bootLogs"),
      guest: {
        ps: str(guest, "ps"),
        meminfo: str(guest, "meminfo"),
        pressureCpu: str(guest, "pressureCpu"),
        pressureMemory: str(guest, "pressureMemory"),
        pressureIo: str(guest, "pressureIo"),
      },
    },
  };
}

/** The first phase name a candidate line names, or null. */
function phaseOnLine(line: string): string | null {
  for (const pattern of PHASE_PATTERNS) {
    const m = pattern.exec(line);
    if (m) return m[1]!;
  }
  return null;
}

/**
 * The signature a hard kill files under. The phase is the last one the worker
 * log names: the last log line first, then the log tail from its end.
 */
export function hardKillSignature(
  evidence: HardKillEvidence,
): HardKillSignature {
  const candidates = [
    evidence.lastLogLine,
    ...evidence.evidence.workerLogTail.split("\n").reverse(),
  ];
  let phase: string | null = null;
  for (const line of candidates) {
    phase = phaseOnLine(line);
    if (phase !== null) {
      if (!PHASE_NAME.test(phase)) phase = "unknown";
      break;
    }
  }
  const handler = slug(evidence.trigger);
  const phaseSlug = slug(phase ?? "unknown");
  return {
    handler,
    phase: phaseSlug,
    failureClass: `hard-kill-${handler}-${phaseSlug}`,
  };
}

/** The last `owner/repo#N` in `text`, or null. */
function lastSourceIn(text: string): HardKillSource | null {
  let last: HardKillSource | null = null;
  for (const m of text.slice(-SOURCE_SCAN_CHARS).matchAll(SOURCE_PATTERN)) {
    last = { repo: m[1]!, issueNumber: parseInt(m[2]!, 10) };
  }
  return last;
}

/** The repo and issue the killed run was working, from the log lines. */
export function hardKillSource(evidence: HardKillEvidence): HardKillSource {
  return lastSourceIn(evidence.lastLogLine) ??
    lastSourceIn(evidence.evidence.workerLogTail) ??
    { repo: "unknown", issueNumber: 0 };
}

/** Title for the filed issue; dedup never uses it. */
export function formatHardKillTitle(sig: HardKillSignature): string {
  return `Hard kill: container wedged in ${sig.phase} (${sig.handler})`;
}

/**
 * Issue body: marker first, then the facts the worker and launcher wrote. No
 * evidence text, last log line, tool call or source repository: the issue is
 * public and the run may have been working a private repository (see the
 * module comment). The evidence stays in the archived file on the host.
 */
export function formatHardKillBody(
  evidence: HardKillEvidence,
  sig: HardKillSignature,
): string {
  return [
    formatRunFailureMarker(sig.failureClass),
    "",
    "Auto-filed by the Vibe Coder (Issue #4254): a container wedged and the launcher watchdog reaped it, so the run never released its claim. The worker found the evidence file on its next start.",
    "",
    `**Host:** \`${inlineText(evidence.host, 200)}\``,
    `**Container:** \`${inlineText(evidence.container, 200)}\``,
    `**Run id:** \`${inlineText(evidence.runId, 200)}\``,
    `**Handler:** \`${sig.handler}\``,
    `**Phase:** \`${sig.phase}\``,
    `**Trigger:** ${inlineText(evidence.trigger, 100)}`,
    `**Reason:** ${publicReason(evidence.trigger)}`,
    `**Captured at:** ${inlineText(evidence.capturedAt, 100)}`,
    `**Last log time:** ${inlineText(evidence.lastLogTimestamp, 100)}`,
    "",
    `The evidence (worker log, agent transcript, boot logs and guest probes) is kept on that host in \`~/logs/${HARD_KILL_ARCHIVE_DIR}/\`. It is never posted here, because it can hold private repository content.`,
  ].join("\n");
}

/** The run-callback record of one hard kill (callback `failureClass` hard_kill). */
export function hardKillTerminalRun(
  evidence: HardKillEvidence,
  sig: HardKillSignature,
): TerminalIssueRun {
  const source = hardKillSource(evidence);
  const at = Date.parse(evidence.capturedAt);
  const runId = evidence.runId === UNKNOWN_RUN_ID ? undefined : evidence.runId;
  return {
    repo: source.repo,
    issueNumber: source.issueNumber,
    result: "failure",
    startedAtEpochMs: at,
    finishedAtEpochMs: at,
    ...(runId !== undefined ? { runId } : {}),
    outcome: {
      kind: "no_pr",
      category: "unknown",
      phase: sig.phase,
      elapsedSeconds: 0,
      message: safeText(evidence.reason, 500),
      classification: {
        fixability: "code_fixable",
        failureClass: HARD_KILL_FAILURE_CLASS,
        rationale: "the launcher watchdog reaped a wedged container",
      },
    },
    phase: sig.phase,
  };
}

/** The follow-up line one hard kill adds to the open issue. */
function formatHardKillOccurrenceLine(
  evidence: HardKillEvidence,
): string {
  return `- ${inlineText(evidence.capturedAt, 100)} \`${
    inlineText(evidence.host, 200)
  }\` — container \`${inlineText(evidence.container, 200)}\`, run \`${
    inlineText(evidence.runId, 200)
  }\``;
}

/** The first line of an error, redacted, for the decision's cause. */
function firstLineCause(err: unknown): string {
  const first = errorText(err).split("\n")[0]?.trim() ?? "";
  return inlineText(first, 300) || "gh failed with no message";
}

export interface FileHardKillIssueOptions {
  evidence: HardKillEvidence;
  /** gh runner: resolves stdout, rejects on failure. */
  ghFn: (args: string[]) => Promise<string>;
  /** Injected clock (epoch seconds). */
  nowSeconds?: number;
  log?: (message: string) => void;
  /** Fleet logins whose markers are trusted; omitted reads the configured fleet. */
  fleetAuthors?: readonly string[];
  /** Records the filing attestation (Issue #1277). Production omits it. */
  recordFiling?: (filing: SelfDiagnosticFiling) => Promise<boolean>;
  /**
   * The open issue this signature already has, when the caller filed or
   * commented on it earlier in the same pass. The search is skipped: GitHub's
   * index may not show an issue created moments ago (Issue #4315 review).
   */
  knownIssueNumber?: number;
}

/**
 * File one hard kill as a deduplicated issue, or comment on the open one.
 *
 * There is no per-host rate limit: each evidence file is one kill, and the
 * caller only removes the file once it has been reported. Every GitHub
 * failure returns `failed` with the gh error's first line. It throws only for
 * a programming error, a refused label, which `reportPendingHardKills`
 * catches per file.
 */
export async function fileHardKillIssue(
  opts: FileHardKillIssueOptions,
): Promise<HardKillFilingResult> {
  const log = opts.log ?? (() => {});
  try {
    parseHardKillEvidence(JSON.stringify(opts.evidence));
  } catch (err) {
    return { action: "failed", cause: firstLineCause(err) };
  }
  const sig = hardKillSignature(opts.evidence);
  const t = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  // Built before the try: a refused label is a programming error and must
  // fail loud, not be reported as a `failed` filing.
  const labelArgs = guardedLabelArgs(["bug"], FILED_BY);
  const title = formatHardKillTitle(sig);
  const body = formatHardKillBody(opts.evidence, sig);

  try {
    // 1. Existing open issue for the signature, matched on the marker AND the
    // author (run_failure_issue.ts step 1, shared).
    const match = opts.knownIssueNumber !== undefined
      ? { number: opts.knownIssueNumber }
      : await findOpenRunFailureIssue({
        ghFn: opts.ghFn,
        targetRepo: RUN_FAILURE_TARGET_REPO,
        failureClass: sig.failureClass,
        fleetAuthors: opts.fleetAuthors,
        log,
      });

    // 2. None → file one (run_failure_issue.ts step 2, shared).
    if (!match) {
      const { issueNumber } = await createRunFailureIssue({
        ghFn: opts.ghFn,
        targetRepo: RUN_FAILURE_TARGET_REPO,
        title,
        body,
        labelArgs,
        failureClass: sig.failureClass,
        filedBy: FILED_BY,
        log: opts.log,
        recordFiling: opts.recordFiling,
      });
      return { action: "filed", issueNumber };
    }

    // 3. Exists → at most one follow-up per window, shared with run-failure.
    const { updated } = await postRunFailureFollowUp({
      ghFn: opts.ghFn,
      targetRepo: RUN_FAILURE_TARGET_REPO,
      issueNumber: match.number,
      failureClass: sig.failureClass,
      nowSeconds: t,
      windowSeconds: RUN_FAILURE_FOLLOWUP_WINDOW_SECONDS,
      occurrenceLine: formatHardKillOccurrenceLine(opts.evidence),
      recurrenceText: "the launcher watchdog reaped another wedged container",
      log,
      fleetAuthors: opts.fleetAuthors,
    });
    return { action: "commented", issueNumber: match.number, updated };
  } catch (err) {
    const cause = firstLineCause(err);
    recordFaultEvent(
      "catch_block_warning",
      `hard-kill issue filing failed (class ${sig.failureClass}): ${cause}`,
    );
    return { action: "failed", cause };
  }
}

export interface ReportPendingHardKillsOptions {
  /** Host log directory holding the evidence files. */
  evidenceDir: string;
  /** gh runner: resolves stdout, rejects on failure. */
  ghFn: (args: string[]) => Promise<string>;
  /** Fires the `failure` run callback for one hard kill. */
  runFailureCallback: (run: TerminalIssueRun) => Promise<void>;
  /** Counts the hard kill as a failure in fleet telemetry. */
  countFailure: () => void;
  seams?: HardKillSeams;
  /** Injected clock (epoch seconds). */
  nowSeconds?: number;
  log?: (message: string) => void;
  /**
   * A malformed or wrong-version file, or an unexpected failure: kept, and
   * never recovered by a retry.
   */
  logError?: (message: string) => void;
  /**
   * A failed filing, failed callback, failed count or failed removal: retried
   * or tolerated. Defaults to `logError`.
   */
  logWarn?: (message: string) => void;
  fleetAuthors?: readonly string[];
  recordFiling?: (filing: SelfDiagnosticFiling) => Promise<boolean>;
}

/** Epoch from a `hard-kill-<container>-<epoch>.json` name; 0 when absent. */
function epochOf(name: string): number {
  const m = /-(\d+)\.json$/.exec(name);
  return m ? parseInt(m[1]!, 10) : 0;
}

/**
 * Report every pending hard-kill evidence file, oldest first, one at a time.
 *
 * A file is archived only after it has been filed and its callback has fired.
 * Anything that goes wrong keeps the file, so the next start reports it once.
 * The one exception is a file that cannot be archived after the report: it
 * stays, and the next start reports it again. Never throws.
 */
export async function reportPendingHardKills(
  opts: ReportPendingHardKillsOptions,
): Promise<HardKillReportSummary> {
  const log = opts.log ?? (() => {});
  const logError = opts.logError ?? (() => {});
  const logWarn = opts.logWarn ?? logError;
  const seams = opts.seams ?? defaultHardKillSeams;
  const summary: HardKillReportSummary = { found: 0, reported: 0, kept: 0 };

  const pruneArchive = async () => {
    try {
      await seams.pruneArchive(
        opts.evidenceDir,
        (opts.nowSeconds ?? Date.now() / 1000) * 1000,
      );
    } catch (err) {
      logWarn(`hard-kill archive cleanup failed: ${errorText(err)}`);
    }
  };
  await pruneArchive();
  let names: string[];
  try {
    names = await seams.listEvidenceFiles(opts.evidenceDir);
  } catch (err) {
    // A host with no evidence directory has nothing pending: say nothing.
    if (!isNotFound(err)) {
      logWarn(
        `hard-kill evidence directory ${opts.evidenceDir} could not be read: ${
          errorText(err)
        }`,
      );
    }
    return summary;
  }
  names = [...names].sort((a, b) =>
    epochOf(a) - epochOf(b) || (a < b ? -1 : a > b ? 1 : 0)
  );
  summary.found = names.length;
  // Signature → issue filed or commented on in this pass (Issue #4315 review).
  const issueBySignature = new Map<string, number>();

  for (const name of names) {
    const path = `${opts.evidenceDir}/${name}`;
    try {
      let evidence: HardKillEvidence;
      try {
        evidence = parseHardKillEvidence(await seams.readTextFile(path));
      } catch (err) {
        logError(
          `hard-kill evidence ${name} could not be read or parsed, kept: ${
            errorText(err)
          }`,
        );
        summary.kept++;
        continue;
      }

      const signature = hardKillSignature(evidence).failureClass;
      const filing = await fileHardKillIssue({
        evidence,
        ghFn: opts.ghFn,
        nowSeconds: opts.nowSeconds,
        log,
        fleetAuthors: opts.fleetAuthors,
        recordFiling: opts.recordFiling,
        knownIssueNumber: issueBySignature.get(signature),
      });
      if (filing.action === "failed") {
        logWarn(
          `hard-kill evidence ${name}: filing failed, kept for the next start: ${filing.cause}`,
        );
        summary.kept++;
        continue;
      }
      issueBySignature.set(signature, filing.issueNumber);
      const where = filing.action === "filed"
        ? `filed #${filing.issueNumber}`
        : `commented on #${filing.issueNumber} (updated=${filing.updated})`;
      log(`hard-kill evidence ${name}: ${where}`);

      try {
        await opts.runFailureCallback(
          hardKillTerminalRun(evidence, hardKillSignature(evidence)),
        );
      } catch (err) {
        logWarn(
          `hard-kill evidence ${name}: failure callback threw: ${
            errorText(err)
          }`,
        );
      }
      try {
        opts.countFailure();
      } catch (err) {
        logWarn(
          `hard-kill evidence ${name}: counting the failure threw: ${
            errorText(err)
          }`,
        );
      }
      summary.reported++;

      try {
        await seams.archiveFile(path);
      } catch (err) {
        summary.kept++;
        logWarn(
          `hard-kill evidence ${name} was reported but could not be archived, so it stays and may be reported again: ${
            errorText(err)
          }`,
        );
      }
    } catch (err) {
      summary.kept++;
      logError(
        `hard-kill evidence ${name}: unexpected failure, kept: ${
          errorText(err)
        }`,
      );
    }
  }
  await pruneArchive();
  return summary;
}
