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
 *   `hard_kill`, and counts the kill as a failure;
 * - keeps the file whenever filing fails, so the next start retries it.
 *
 * Every free-text value from the evidence is redacted before it is bounded,
 * has comment delimiters neutralised and has its code fences replaced, the
 * same way the run-failure excerpt is. Every GitHub and file call is wrapped:
 * nothing here throws into the worker's start-up path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { neutraliseCommentDelimiters } from "./agent_marker_neutralisation.ts";
import {
  ALERT_DEDUP_JSON_FIELDS,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";
import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { guardedLabelArgs } from "./guarded_issue_labels.ts";
import {
  HARD_KILL_EVIDENCE_VERSION,
  type HardKillEvidence,
} from "./hard_kill_evidence.ts";
import { redactedTail } from "./redacted_text.ts";
import type { TerminalIssueRun } from "./run_callbacks.ts";
import {
  formatRunFailureMarker,
  isRunFailureIssue,
  postRunFailureFollowUp,
  RUN_FAILURE_FAMILY_ID,
  RUN_FAILURE_FOLLOWUP_WINDOW_SECONDS,
  RUN_FAILURE_MARKER_PREFIX,
  RUN_FAILURE_TARGET_REPO,
} from "./run_failure_issue.ts";
import {
  recordSelfDiagnosticFiling,
  type SelfDiagnosticFiling,
} from "./self_diagnostic_attestation.ts";

/** The callback `failureClass` and the fleet failure class of a hard kill. */
export const HARD_KILL_FAILURE_CLASS = "hard_kill";
/** Evidence file name: `hard-kill-<container>-<epoch>.json` (Issue #4253). */
export const HARD_KILL_FILE_PATTERN = /^hard-kill-.+\.json$/;
/** The `runId` the evidence writes when the run was not known. */
const UNKNOWN_RUN_ID = "unknown";
/** Tail budget for each log-like evidence section, in characters. */
const SECTION_CHARS = 6000;
/** Tail budget for each guest probe section, in characters. */
const GUEST_SECTION_CHARS = 4000;
/** Budget for a single-line value (last log line, reason, …). */
const LINE_CHARS = 2000;
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
/** `owner/repo#N`; the two name classes are disjoint, so no backtracking blow-up. */
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
  removeFile(path: string): Promise<void>;
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
  removeFile: (path: string) => Deno.remove(path),
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
  if (Number.isNaN(Date.parse(capturedAt))) {
    throw new Error(
      `hard-kill evidence field "capturedAt" is not an ISO-8601 time`,
    );
  }
  return {
    version: HARD_KILL_EVIDENCE_VERSION,
    capturedAt,
    host: str(raw, "host"),
    container: str(raw, "container"),
    runId: str(raw, "runId"),
    trigger: str(raw, "trigger"),
    reason: str(raw, "reason"),
    lastLogLine: str(raw, "lastLogLine"),
    lastLogTimestamp: str(raw, "lastLogTimestamp"),
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
    if (phase !== null) break;
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

/** One fenced, redacted, bounded evidence section. */
function fencedSection(
  title: string,
  text: string,
  maxChars: number,
): string[] {
  const body = safeText(text, maxChars);
  return [
    "",
    `### ${title}`,
    "",
    "```",
    body === "" ? "(empty)" : body,
    "```",
  ];
}

/**
 * Issue body: marker first, then the labelled facts a human needs, then the
 * redacted evidence. Each section is bounded, so a maximal evidence file
 * stays well under GitHub's body limit.
 */
export function formatHardKillBody(
  evidence: HardKillEvidence,
  sig: HardKillSignature,
): string {
  const source = hardKillSource(evidence);
  const e = evidence.evidence;
  const lines: string[] = [
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
    `**Reason:** ${inlineText(evidence.reason, LINE_CHARS)}`,
    `**Captured at:** ${inlineText(evidence.capturedAt, 100)}`,
    `**Last log line:** \`${inlineText(evidence.lastLogLine, LINE_CHARS)}\``,
    `**Last log time:** ${inlineText(evidence.lastLogTimestamp, 100)}`,
    `**Last tool call:** ${inlineText(evidence.lastToolCall, 500)}`,
    ...(source.repo !== "unknown"
      ? [`**Source:** ${inlineText(source.repo, 200)}#${source.issueNumber}`]
      : []),
    "",
    "## Evidence (redacted; each section is its tail, bounded)",
    ...fencedSection("Worker log tail", e.workerLogTail, SECTION_CHARS),
    ...fencedSection(
      "Agent transcript tail",
      e.agentTranscriptTail,
      SECTION_CHARS,
    ),
    ...fencedSection("Boot logs", e.bootLogs, SECTION_CHARS),
    ...fencedSection("Guest ps", e.guest.ps, GUEST_SECTION_CHARS),
    ...fencedSection("Guest meminfo", e.guest.meminfo, GUEST_SECTION_CHARS),
    ...fencedSection(
      "Guest pressure (cpu)",
      e.guest.pressureCpu,
      GUEST_SECTION_CHARS,
    ),
    ...fencedSection(
      "Guest pressure (memory)",
      e.guest.pressureMemory,
      GUEST_SECTION_CHARS,
    ),
    ...fencedSection(
      "Guest pressure (io)",
      e.guest.pressureIo,
      GUEST_SECTION_CHARS,
    ),
  ];
  return lines.join("\n");
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
  const source = hardKillSource(evidence);
  const repoRef = source.repo === "unknown"
    ? "source unknown"
    : `${inlineText(source.repo, 200)}#${source.issueNumber}`;
  return `- ${inlineText(evidence.capturedAt, 100)} \`${
    inlineText(evidence.host, 200)
  }\` — container \`${inlineText(evidence.container, 200)}\`, run \`${
    inlineText(evidence.runId, 200)
  }\`, ${repoRef}`;
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
  /** Target repo override (tests). Production: RUN_FAILURE_TARGET_REPO. */
  targetRepo?: string;
  /** Injected clock (epoch seconds). */
  nowSeconds?: number;
  /** Follow-up window override (tests). */
  followUpWindowSeconds?: number;
  log?: (message: string) => void;
  /** Fleet logins whose markers are trusted; omitted reads the configured fleet. */
  fleetAuthors?: readonly string[];
  /** Records the filing attestation (Issue #1277). Production omits it. */
  recordFiling?: (filing: SelfDiagnosticFiling) => Promise<boolean>;
}

/**
 * File one hard kill as a deduplicated issue, or comment on the open one.
 *
 * There is no per-host rate limit: each evidence file is one kill, and the
 * caller only removes the file once it has been reported. Never throws; a
 * failed GitHub call returns `failed` with the gh error's first line.
 */
export async function fileHardKillIssue(
  opts: FileHardKillIssueOptions,
): Promise<HardKillFilingResult> {
  const log = opts.log ?? (() => {});
  const sig = hardKillSignature(opts.evidence);
  const targetRepo = opts.targetRepo ?? RUN_FAILURE_TARGET_REPO;
  const t = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const window = opts.followUpWindowSeconds ??
    RUN_FAILURE_FOLLOWUP_WINDOW_SECONDS;
  // Built before the try: a refused label is a programming error and must
  // fail loud, not be reported as a `failed` filing.
  const labelArgs = guardedLabelArgs(["bug"], FILED_BY);
  const title = formatHardKillTitle(sig);
  const body = formatHardKillBody(opts.evidence, sig);

  try {
    // 1. Existing open issue for the signature, matched on the marker AND the
    // author (as run_failure_issue.ts step 1 does).
    const raw = await opts.ghFn([
      "issue",
      "list",
      "--repo",
      targetRepo,
      "--state",
      "open",
      "--search",
      `"${RUN_FAILURE_MARKER_PREFIX}:${sig.failureClass}" in:body`,
      "--json",
      ALERT_DEDUP_JSON_FIELDS,
      "--limit",
      "20",
    ]);
    const list = JSON.parse(raw || "[]") as AlertDedupRow[];
    const verified = await selectFleetAuthoredMatches(
      list.filter((i) => isRunFailureIssue(i.body ?? "", sig.failureClass)),
      `hard kill ${sig.failureClass}`,
      { fleetAuthors: opts.fleetAuthors },
      log,
    );
    const match = verified.sort((a, b) => a.number - b.number)[0];

    // 2. None → file one.
    if (!match) {
      const createRaw = await opts.ghFn([
        "issue",
        "create",
        "--repo",
        targetRepo,
        "--title",
        title,
        "--body",
        body,
        ...labelArgs,
      ]);
      const m = /\/issues\/(\d+)\s*$/.exec(createRaw.trim());
      const issueNumber = m ? parseInt(m[1]!, 10) : 0;
      // Issue #1277: attest the filing out of band, so tier 2b can tell this
      // diagnostic from one an injected agent typed the marker into.
      const recordFiling = opts.recordFiling ??
        ((filing: SelfDiagnosticFiling) =>
          recordSelfDiagnosticFiling(filing, { log: opts.log }));
      await recordFiling({
        repo: targetRepo,
        issueNumber,
        familyId: RUN_FAILURE_FAMILY_ID,
        title,
        body,
        filedBy: FILED_BY,
      });
      return { action: "filed", issueNumber };
    }

    // 3. Exists → at most one follow-up per window, shared with run-failure.
    const { updated } = await postRunFailureFollowUp({
      ghFn: opts.ghFn,
      targetRepo,
      issueNumber: match.number,
      failureClass: sig.failureClass,
      nowSeconds: t,
      windowSeconds: window,
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
  logError?: (message: string) => void;
  targetRepo?: string;
  followUpWindowSeconds?: number;
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
 * A file is removed only after it has been filed and its callback has fired.
 * Anything that goes wrong keeps the file, so the next start reports it once.
 * Never throws.
 */
export async function reportPendingHardKills(
  opts: ReportPendingHardKillsOptions,
): Promise<HardKillReportSummary> {
  const log = opts.log ?? (() => {});
  const logError = opts.logError ?? (() => {});
  const seams = opts.seams ?? defaultHardKillSeams;
  const summary: HardKillReportSummary = { found: 0, reported: 0, kept: 0 };

  let names: string[];
  try {
    names = await seams.listEvidenceFiles(opts.evidenceDir);
  } catch (err) {
    // A host with no evidence directory has nothing pending: say nothing.
    if (!isNotFound(err)) {
      logError(
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

      const filing = await fileHardKillIssue({
        evidence,
        ghFn: opts.ghFn,
        targetRepo: opts.targetRepo,
        nowSeconds: opts.nowSeconds,
        followUpWindowSeconds: opts.followUpWindowSeconds,
        log,
        fleetAuthors: opts.fleetAuthors,
        recordFiling: opts.recordFiling,
      });
      if (filing.action === "failed") {
        logError(
          `hard-kill evidence ${name}: filing failed, kept for the next start: ${filing.cause}`,
        );
        summary.kept++;
        continue;
      }
      const where = filing.action === "filed"
        ? `filed #${filing.issueNumber}`
        : `commented on #${filing.issueNumber} (updated=${filing.updated})`;
      log(`hard-kill evidence ${name}: ${where}`);

      try {
        await opts.runFailureCallback(
          hardKillTerminalRun(evidence, hardKillSignature(evidence)),
        );
      } catch (err) {
        logError(
          `hard-kill evidence ${name}: failure callback threw: ${
            errorText(err)
          }`,
        );
      }
      try {
        opts.countFailure();
      } catch (err) {
        logError(
          `hard-kill evidence ${name}: counting the failure threw: ${
            errorText(err)
          }`,
        );
      }
      summary.reported++;

      try {
        await seams.removeFile(path);
      } catch (err) {
        summary.kept++;
        logError(
          `hard-kill evidence ${name} was reported but could not be removed, so it stays and may be reported again: ${
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
  return summary;
}
