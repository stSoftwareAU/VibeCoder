/**
 * Shift-left detection of repeated fleet PR CI failures (Issue #4610).
 *
 * ## Why
 *
 * A fleet PR that fails CI costs a full CI run and a second agent session to
 * repair it. The fleet's Macs are already paid for; GitHub Actions minutes are
 * not. A check that keeps failing in CI on fleet PRs, and that could run on the
 * Mac before the PR is raised, is a gap to close at its source.
 *
 * ## The design
 *
 * - Each babysitter pass reads the PR workflow runs that failed since its last
 *   scan, and records one observation per failed job of a fleet PR. A job
 *   counts only when its failed step runs a recognised local tool
 *   ({@link detectTool}) and {@link classifyCiFailure} calls the failure a
 *   code fault. Infrastructure, timing, human-gate, aggregator and
 *   deployment-state failures are never counted.
 * - Observations are grouped by repository, check and failed step, with
 *   matrix shard numbers folded. A group that has failed on
 *   {@link SHIFT_LEFT_THRESHOLD} distinct fleet PRs within
 *   {@link SHIFT_LEFT_WINDOW_DAYS} days is a repeated failure.
 * - It is routed to the repository that owns the fix:
 *   - VibeCoder, when most failing heads were pushed by the babysitter, or the
 *     repository's local gate (`quality.sh`) already runs the tool. Either way
 *     the fleet raised or pushed without a passing local gate.
 *   - The product repository, when CI runs a tool its local gate does not.
 * - One issue per group, found again by a body marker. A recurrence comments
 *   on the open issue at most once a day; recurrence after it was closed
 *   files a new issue linking the old one.
 * - A VibeCoder issue for a private source names neither the repository nor
 *   its PRs.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { classifyCiFailure } from "./ci_failure_classifier.ts";
import { neutraliseCommentDelimiters } from "./agent_marker_neutralisation.ts";
import { atomicWrite } from "./file_utils.ts";
import { guardedLabelArgs } from "./guarded_issue_labels.ts";
import { redactedLogTail } from "./redacted_text.ts";
import { getRepoVisibility } from "./repo_visibility.ts";
import { selectFleetAuthoredMatches } from "./alert_dedup_authors.ts";

/** Distinct fleet PRs a step must fail on before it is a repeated failure. */
export const SHIFT_LEFT_THRESHOLD = 3;
/** The window the threshold is counted over. */
export const SHIFT_LEFT_WINDOW_DAYS = 7;
/** Observations older than this are dropped from the ledger. */
export const SHIFT_LEFT_RETENTION_DAYS = 14;
/** At most one write per issue in this interval. */
export const SHIFT_LEFT_WRITE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Overlap between scans, so a run finishing during a pass is not missed. */
const SCAN_OVERLAP_MS = 60 * 60 * 1000;
/**
 * Failed runs inspected per repository per pass. The first pass on a busy
 * repository would otherwise read a week of runs before any repair starts;
 * the rest are picked up on later passes.
 */
export const SHIFT_LEFT_MAX_RUNS_PER_PASS = 40;
/** Bytes of job log kept for classification. */
const LOG_TAIL_BYTES = 64 * 1024;
/** Marker prefix; the body carries `<!-- VIBE_SHIFT_LEFT:<key> -->`. */
export const SHIFT_LEFT_MARKER_PREFIX = "VIBE_SHIFT_LEFT";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One failed job of a fleet PR. */
export interface FailureObservation {
  repo: string;
  runId: number;
  jobId: number;
  prNumber: number;
  headSha: string;
  /** Who pushed the failing head (the run's triggering actor). */
  pushedBy: string;
  check: string;
  step: string;
  tool: string;
  /** Stable lint or error codes seen in the log, e.g. `clippy::indexing_slicing`. */
  codes: string[];
  observedAtMs: number;
}

/** What a filed group last did, keyed by {@link shiftLeftKey}. */
export interface ShiftLeftFiling {
  targetRepo: string;
  issueNumber?: number;
  lastWriteMs: number;
}

/** Persistent babysitter state for this detector. */
export interface ShiftLeftLedger {
  version: 1;
  observations: FailureObservation[];
  filings: Record<string, ShiftLeftFiling>;
  lastScanMs: Record<string, number>;
  /** Runs already inspected, per repository: run id → created time. */
  scannedRuns?: Record<string, Record<string, number>>;
}

/** A step that has failed on enough distinct fleet PRs. */
export interface RepeatedFailure {
  key: string;
  repo: string;
  check: string;
  step: string;
  tool: string;
  prNumbers: number[];
  pushers: string[];
  codes: string[];
  observations: FailureObservation[];
  /**
   * Set on a generic group: the repositories whose local gates all lack the
   * tool. The fix is then the fleet's, filed once in VibeCoder.
   */
  repos?: string[];
}

/** Where the fix belongs, and why. */
export interface ShiftLeftRoute {
  target: "vibecoder" | "product";
  reason: string;
}

export function emptyShiftLeftLedger(): ShiftLeftLedger {
  return { version: 1, observations: [], filings: {}, lastScanMs: {} };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** Local tools, most specific first. The name doubles as the display text. */
const TOOLS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "cargo clippy", pattern: /cargo[\s-]+clippy|\bclippy\b/i },
  { name: "cargo fmt", pattern: /cargo[\s-]+fmt|\brustfmt\b/i },
  { name: "cargo mutants", pattern: /cargo[\s-]+mutants|\bmutants\b/i },
  { name: "cargo llvm-cov", pattern: /llvm-cov/i },
  { name: "cargo deny", pattern: /cargo[\s-]+deny/i },
  { name: "cargo test", pattern: /cargo[\s-]+test/i },
  { name: "deno fmt", pattern: /deno\s+fmt/i },
  { name: "deno lint", pattern: /deno\s+lint/i },
  { name: "deno check", pattern: /deno\s+(?:type[\s-]*)?check\b/i },
  { name: "deno test", pattern: /deno\s+tests?\b/i },
  { name: "markdownlint", pattern: /markdownlint/i },
  { name: "shellcheck", pattern: /shellcheck/i },
  { name: "actionlint", pattern: /actionlint/i },
  { name: "zizmor", pattern: /zizmor/i },
  { name: "cfn-lint", pattern: /cfn-lint/i },
  { name: "gitleaks", pattern: /gitleaks/i },
  { name: "semgrep", pattern: /semgrep/i },
  { name: "eslint", pattern: /eslint/i },
  { name: "prettier", pattern: /prettier/i },
  { name: "tsc", pattern: /\btsc\b/i },
  { name: "pytest", pattern: /pytest/i },
  { name: "ruff", pattern: /\bruff\b/i },
];

const DENO_TASK = /deno\s+task\s+([\w:.-]+)/i;

/**
 * The local tool a CI step runs, or null when none is recognised. A step with
 * no recognised tool is never counted: an aggregator or a deployment-state
 * check has no local equivalent to shift left to.
 */
export function detectTool(text: string): string | null {
  const task = DENO_TASK.exec(text);
  if (task) return `deno task ${task[1]}`;
  return TOOLS.find((t) => t.pattern.test(text))?.name ?? null;
}

/** Whether the local gate script runs the tool. */
export function localGateRunsTool(gate: string | null, tool: string): boolean {
  if (gate === null) return false;
  if (tool.startsWith("deno task ")) {
    return gate.includes(tool.slice("deno task ".length));
  }
  const entry = TOOLS.find((t) => t.name === tool);
  return entry !== undefined && entry.pattern.test(gate);
}

/** Fold matrix shard numbers (`tests 2/4`, `shard 1 of 4`) into one label. */
export function normaliseCheckLabel(label: string): string {
  return label.replace(/\d+(\s*(?:\/|of)\s*)\d+/g, "N$1N").trim();
}

/** Lint and error codes worth naming in an issue. */
function extractCodes(log: string): string[] {
  const codes = new Set<string>();
  for (const m of log.matchAll(/clippy::([a-z][a-z_-]+)/g)) {
    codes.add(`clippy::${m[1]!.replaceAll("-", "_")}`);
  }
  for (const m of log.matchAll(/\b(MD\d{3})\b/g)) codes.add(m[1]!);
  for (const m of log.matchAll(/error\[(E\d{4})\]/g)) codes.add(m[1]!);
  return [...codes].sort();
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

/** Stable, opaque key for a repository, check and step. */
export async function shiftLeftKey(
  repo: string,
  check: string,
  step: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${repo.toLowerCase()}\n${normaliseCheckLabel(check)}\n${
        normaliseCheckLabel(step)
      }`,
    ),
  );
  return [...new Uint8Array(digest)].slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Add observations, deduplicated by job, and drop expired ones. */
export function recordObservations(
  ledger: ShiftLeftLedger,
  observations: readonly FailureObservation[],
  nowMs: number,
): void {
  const seen = new Set(ledger.observations.map((o) => `${o.repo}#${o.jobId}`));
  for (const o of observations) {
    const id = `${o.repo}#${o.jobId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    ledger.observations.push(o);
  }
  const cutoff = nowMs - SHIFT_LEFT_RETENTION_DAYS * DAY_MS;
  ledger.observations = ledger.observations.filter((o) =>
    o.observedAtMs >= cutoff
  );
  for (const runs of Object.values(ledger.scannedRuns ?? {})) {
    for (const [id, createdMs] of Object.entries(runs)) {
      if (createdMs < cutoff) delete runs[id];
    }
  }
}

/** Groups that failed on at least the threshold of distinct PRs. */
export async function repeatedFailures(
  ledger: ShiftLeftLedger,
  nowMs: number,
  opts: { threshold?: number; sinceMs?: number } = {},
): Promise<RepeatedFailure[]> {
  const threshold = opts.threshold ?? SHIFT_LEFT_THRESHOLD;
  const since = opts.sinceMs ?? nowMs - SHIFT_LEFT_WINDOW_DAYS * DAY_MS;
  const groups = new Map<string, RepeatedFailure>();
  for (const o of ledger.observations) {
    if (o.observedAtMs < since) continue;
    const key = await shiftLeftKey(o.repo, o.check, o.step);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        repo: o.repo,
        check: normaliseCheckLabel(o.check),
        step: normaliseCheckLabel(o.step),
        tool: o.tool,
        prNumbers: [],
        pushers: [],
        codes: [],
        observations: [],
      };
      groups.set(key, group);
    }
    group.observations.push(o);
    group.pushers.push(o.pushedBy);
    if (!group.prNumbers.includes(o.prNumber)) group.prNumbers.push(o.prNumber);
    for (const c of o.codes) if (!group.codes.includes(c)) group.codes.push(c);
  }
  return [...groups.values()]
    .filter((g) => g.prNumbers.length >= threshold)
    .map((g) => ({
      ...g,
      prNumbers: g.prNumbers.sort((a, b) => a - b),
      codes: g.codes.sort(),
    }));
}

// ---------------------------------------------------------------------------
// Routing and issue text
// ---------------------------------------------------------------------------

/** Decide which repository owns the fix. */
export function routeShiftLeftFix(
  group: Pick<RepeatedFailure, "tool" | "pushers">,
  localGate: string | null,
  babysitterLogins: readonly string[],
): ShiftLeftRoute {
  const bots = new Set(babysitterLogins.map((l) => l.toLowerCase()));
  const byBabysitter =
    group.pushers.filter((p) => bots.has(p.toLowerCase())).length;
  if (byBabysitter * 2 >= group.pushers.length && byBabysitter > 0) {
    return {
      target: "vibecoder",
      reason: `${byBabysitter} of ${group.pushers.length} failing heads were ` +
        `pushed by the fleet PR babysitter without running \`${group.tool}\` ` +
        `locally first`,
    };
  }
  if (localGateRunsTool(localGate, group.tool)) {
    return {
      target: "vibecoder",
      reason: `the repository's local gate already runs \`${group.tool}\`, ` +
        `so the fleet raised or pushed these PRs without a passing local gate`,
    };
  }
  return {
    target: "product",
    reason: localGate === null
      ? `the repository has no \`quality.sh\` local gate, so nothing runs ` +
        `\`${group.tool}\` before a PR is raised`
      : `the repository's local gate does not run \`${group.tool}\`, so ` +
        `nothing catches this before a PR is raised`,
  };
}

/** Repositories a tool must be missing locally in before it is generic. */
export const SHIFT_LEFT_GENERIC_REPOS = 2;

/**
 * Merge product-routed groups for the same tool across repositories. A check
 * that CI runs but no local gate does, in two or more repositories, is a
 * fleet-wide gap: one VibeCoder issue, not one per repository.
 */
export async function genericGroups(
  routed: ReadonlyArray<{ group: RepeatedFailure; route: ShiftLeftRoute }>,
): Promise<{ group: RepeatedFailure; route: ShiftLeftRoute }[]> {
  const byTool = new Map<string, RepeatedFailure[]>();
  for (const { group, route } of routed) {
    if (route.target !== "product") continue;
    byTool.set(group.tool, [...(byTool.get(group.tool) ?? []), group]);
  }
  const out: { group: RepeatedFailure; route: ShiftLeftRoute }[] = [];
  for (const [tool, groups] of byTool) {
    const repos = [...new Set(groups.map((g) => g.repo))].sort();
    if (repos.length < SHIFT_LEFT_GENERIC_REPOS) continue;
    const observations = groups.flatMap((g) => g.observations);
    out.push({
      group: {
        key: await shiftLeftKey("*", "generic", tool),
        repo: "*",
        check: [...new Set(groups.map((g) => g.check))].join(", "),
        step: [...new Set(groups.map((g) => g.step))].join(", "),
        tool,
        prNumbers: groups.flatMap((g) => g.prNumbers),
        pushers: groups.flatMap((g) => g.pushers),
        codes: [...new Set(groups.flatMap((g) => g.codes))].sort(),
        observations,
        repos,
      },
      route: {
        target: "vibecoder",
        reason: `CI runs \`${tool}\` but no local gate does in ` +
          `${repos.length} repositories, so this is a fleet-wide gap rather ` +
          `than one repository's`,
      },
    });
  }
  return out;
}

export function formatShiftLeftMarker(key: string): string {
  return `<!-- ${SHIFT_LEFT_MARKER_PREFIX}:${key} -->`;
}

export function parseShiftLeftMarker(body: string): string | null {
  return new RegExp(
    `<!--\\s*${SHIFT_LEFT_MARKER_PREFIX}:([0-9a-f]{16})\\s*-->`,
  ).exec(body)?.[1] ?? null;
}

/** CI labels are untrusted text: no markers, no code spans, no repo names. */
function label(text: string, hide: readonly string[]): string {
  let out = neutraliseCommentDelimiters(text).replaceAll("`", "'");
  for (const repo of hide) {
    for (const name of [repo, repo.split("/")[1] ?? repo]) {
      out = out.replaceAll(name, "a private repository");
    }
  }
  return out;
}

/** Title and body for a new issue. */
export function formatShiftLeftIssue(
  group: RepeatedFailure,
  route: ShiftLeftRoute,
  opts: { sourcePublic: boolean; recurredAfter?: number },
): { title: string; body: string } {
  const disclose = route.target === "product" || opts.sourcePublic;
  const generic = group.repos !== undefined;
  const hidden = disclose ? [] : group.repos ?? [group.repo];
  const check = label(group.check, hidden);
  const step = label(group.step, hidden);
  const source = route.target === "product"
    ? "this repository"
    : generic
    ? `${group.repos!.length} repositories${
      disclose ? ` (${group.repos!.map((r) => `\`${r}\``).join(", ")})` : ""
    }`
    : disclose
    ? `\`${group.repo}\``
    : "a private repository";
  const prs = route.target === "product"
    ? group.prNumbers.map((n) => `#${n}`).join(", ")
    : disclose
    ? group.observations.map((o) => `${o.repo}#${o.prNumber}`)
      .filter((v, i, a) => a.indexOf(v) === i).join(", ")
    : `${group.prNumbers.length} PRs (withheld: private repository)`;
  const lines = [
    formatShiftLeftMarker(group.key),
    "",
    "Auto-filed by the fleet PR babysitter (Issue #4610): the same CI step " +
    `failed on ${group.prNumbers.length} fleet PRs in ${source} within ` +
    `${SHIFT_LEFT_WINDOW_DAYS} days. Each failure cost a CI run and a ` +
    "second agent session; a local check on the Mac would have caught it " +
    "before the PR was raised.",
    "",
    `- **Check:** ${check}`,
    `- **Failed step:** ${step}`,
    `- **Local tool:** \`${group.tool}\``,
    `- **PRs:** ${prs}`,
  ];
  if (group.codes.length > 0) {
    lines.push(
      `- **Codes seen:** ${group.codes.map((c) => `\`${c}\``).join(", ")}`,
    );
  }
  if (route.target === "product") {
    lines.push(
      "- **Failed jobs:**",
      ...group.observations.slice(-10).map((o) =>
        `  - #${o.prNumber}: https://github.com/${group.repo}/actions/runs/${o.runId}/job/${o.jobId}`
      ),
    );
  }
  if (opts.recurredAfter !== undefined) {
    lines.push("", `This recurred after #${opts.recurredAfter} was closed.`);
  }
  lines.push(
    "",
    "## Why this repository",
    "",
    `Routed here because ${route.reason}.`,
    "",
    "## What to fix",
    "",
    generic
      ? `Give the fleet a local \`${group.tool}\` check, run the way CI runs ` +
        "it, that every repository whose CI runs it gets before a PR is " +
        "raised or a fix is pushed (for example in the worker's pre-PR " +
        "gate), so the failure is caught on the Mac. This adds an earlier " +
        "check; CI stays as the backstop."
      : route.target === "product"
      ? `Add a local equivalent of this CI step to \`quality.sh\` (the same ` +
        `\`${group.tool}\` invocation and flags CI uses), so the Vibe Coder ` +
        "runs it before raising a PR. Keep CI as the backstop."
      : `Make the fleet run \`${group.tool}\` the way CI does, and require it ` +
        "to pass, before a PR is raised or a fix is pushed. Find the path " +
        "that skipped it (a disk-budget deferral that leaves checks to CI, a " +
        "targeted subset, a babysitter push with no local gate) and close it.",
  );
  const title = generic
    ? `Shift left: CI runs \`${group.tool}\` but no local gate does, across ${
      group.repos!.length
    } repositories`
    : route.target === "product"
    ? `Shift left: run \`${group.tool}\` in the local gate so CI '${check}' failures are caught before a PR`
    : `Shift left: fleet PRs keep failing CI on \`${group.tool}\` that a local gate could catch`;
  return { title, body: lines.join("\n") };
}

function formatRecurrence(
  group: RepeatedFailure,
  fresh: FailureObservation[],
  disclose: boolean,
): string {
  const prs = [...new Set(fresh.map((o) => `${o.repo}#${o.prNumber}`))];
  return [
    formatShiftLeftMarker(group.key),
    "",
    `Recurred: \`${group.tool}\` failed again on ${prs.length} more fleet ` +
    `PR(s)${
      disclose ? `: ${prs.join(", ")}` : ""
    }. ${group.prNumbers.length} distinct PRs in the last ` +
    `${SHIFT_LEFT_WINDOW_DAYS} days.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------

export interface ShiftLeftScanDeps {
  repos: readonly string[];
  fleetAuthors: readonly string[];
  babysitterLogins: readonly string[];
  vibeCoderRepo: string;
  ledger: ShiftLeftLedger;
  nowMs: number;
  /** False reports what it would file and writes nothing to GitHub. */
  execute: boolean;
  /** Runs `gh` with these arguments and returns stdout; throws on failure. */
  gh: (args: string[]) => Promise<string>;
  log: (line: string) => void;
  /** Sink for degraded-but-continuing conditions. */
  warn: (line: string) => void;
  /** Overrides {@link SHIFT_LEFT_MAX_RUNS_PER_PASS} (tests, manual backfill). */
  maxRunsPerRepo?: number;
  /** Scopes GitHub writes to the target repository. */
  withWriteScope: <T>(repo: string, action: () => Promise<T>) => Promise<T>;
}

interface RunSummary {
  id: number;
  created_at: string;
  head_sha: string;
  head_branch?: string;
  triggering_actor?: { login?: string } | null;
  pull_requests?: { number: number }[];
}

interface JobSummary {
  id: number;
  name: string;
  steps?: { name: string; conclusion?: string }[];
}

function parseLines<T>(text: string): T[] {
  return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/**
 * The run's PR and its author. GitHub often leaves a run's `pull_requests`
 * empty, so a run without one is matched by its head branch.
 */
async function resolvePr(
  repo: string,
  run: RunSummary,
  cache: Map<string, { number: number; login: string } | null>,
  deps: ShiftLeftScanDeps,
): Promise<{ number: number; login: string } | null> {
  const linked = run.pull_requests?.[0]?.number;
  const cacheKey = linked !== undefined ? `#${linked}` : `@${run.head_branch}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;
  let pr: { number: number; login: string } | null = null;
  if (linked !== undefined) {
    pr = {
      number: linked,
      login: await deps.gh([
        "api",
        `repos/${repo}/pulls/${linked}`,
        "--jq",
        ".user.login",
      ]),
    };
  } else if (run.head_branch) {
    const owner = repo.split("/")[0];
    const line = await deps.gh([
      "api",
      `repos/${repo}/pulls?state=all&head=${owner}:${
        encodeURIComponent(run.head_branch)
      }&per_page=1`,
      "--jq",
      ".[0] | select(. != null) | {number, login: .user.login} | tojson",
    ]);
    pr = line.trim() ? JSON.parse(line) : null;
  }
  cache.set(cacheKey, pr);
  return pr;
}

async function observeRepo(
  repo: string,
  deps: ShiftLeftScanDeps,
): Promise<{ observations: FailureObservation[]; resumeMs: number }> {
  const last = deps.ledger.lastScanMs[repo];
  const since = last === undefined
    ? deps.nowMs - SHIFT_LEFT_WINDOW_DAYS * DAY_MS
    : last - SCAN_OVERLAP_MS;
  const runs = parseLines<RunSummary>(
    await deps.gh([
      "api",
      "--paginate",
      `repos/${repo}/actions/runs?event=pull_request&status=failure&created=>=${
        new Date(since).toISOString()
      }&per_page=100`,
      "--jq",
      ".workflow_runs[] | {id, created_at, head_sha, head_branch, triggering_actor: {login: .triggering_actor.login}, pull_requests: [.pull_requests[] | {number}]} | tojson",
    ]),
  );
  const seen = new Set(
    deps.ledger.observations.filter((o) => o.repo === repo).map((o) => o.jobId),
  );
  const scanned = ((deps.ledger.scannedRuns ??= {})[repo] ??= {});
  const pending = runs
    .filter((run) => scanned[String(run.id)] === undefined)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const batch = pending.slice(
    0,
    deps.maxRunsPerRepo ?? SHIFT_LEFT_MAX_RUNS_PER_PASS,
  );
  // Resume from the last inspected run when the batch stopped short.
  const resumeMs = batch.length < pending.length
    ? Date.parse(batch[batch.length - 1]!.created_at)
    : deps.nowMs;
  const fleet = new Set(deps.fleetAuthors.map((a) => a.toLowerCase()));
  const prs = new Map<string, { number: number; login: string } | null>();
  const out: FailureObservation[] = [];
  for (const run of batch) {
    scanned[String(run.id)] = Date.parse(run.created_at) || deps.nowMs;
    const pr = await resolvePr(repo, run, prs, deps);
    if (pr === null || !fleet.has(pr.login.toLowerCase())) continue;
    const prNumber = pr.number;
    const jobs = parseLines<JobSummary>(
      await deps.gh([
        "api",
        `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`,
        "--jq",
        '.jobs[] | select(.conclusion == "failure") | {id, name, steps: [.steps[] | select(.conclusion == "failure") | {name}]} | tojson',
      ]),
    );
    for (const job of jobs) {
      if (seen.has(job.id)) continue;
      const step = job.steps?.[0]?.name ?? "";
      const tool = detectTool(step) ?? detectTool(job.name);
      if (tool === null) continue;
      let raw: string;
      try {
        raw = await readJobLog(repo, job.id, deps);
      } catch (error) {
        // An expired or missing log costs this job, not the whole scan.
        deps.log(`shift-left: skipped ${repo} job ${job.id}: ${error}`);
        continue;
      }
      const log = redactedLogTail(raw, LOG_TAIL_BYTES);
      const category = classifyCiFailure(job.name, [], log).category;
      if (
        category !== "code-fix-required" &&
        category !== "history-rewrite-required"
      ) continue;
      out.push({
        repo,
        runId: run.id,
        jobId: job.id,
        prNumber,
        headSha: run.head_sha,
        pushedBy: run.triggering_actor?.login ?? "",
        check: job.name,
        step,
        tool,
        codes: extractCodes(log),
        observedAtMs: Date.parse(run.created_at) || deps.nowMs,
      });
    }
  }
  return { observations: out, resumeMs };
}

/** Terminal colour and cursor sequences in a job log. */
// deno-lint-ignore no-control-regex
const ANSI_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * A job's log without terminal escapes. Newer gh refuses to print a response
 * carrying them unless asked; older gh does not know the flag, so it is only
 * passed after that refusal.
 */
async function readJobLog(
  repo: string,
  jobId: number,
  deps: ShiftLeftScanDeps,
): Promise<string> {
  const path = `repos/${repo}/actions/jobs/${jobId}/logs`;
  let log: string;
  try {
    log = await deps.gh(["api", path]);
  } catch (error) {
    if (!/escape sequences/i.test(String(error))) throw error;
    log = await deps.gh(["api", "--allow-escape-sequences", path]);
  }
  return log.replace(ANSI_ESCAPE, "");
}

async function readLocalGate(
  repo: string,
  deps: ShiftLeftScanDeps,
): Promise<string | null> {
  try {
    return await deps.gh([
      "api",
      "-H",
      "Accept: application/vnd.github.raw",
      `repos/${repo}/contents/quality.sh`,
    ]);
  } catch (error) {
    if (/\b404\b|Not Found/i.test(String(error))) return null;
    throw error;
  }
}

async function isPublic(repo: string, deps: ShiftLeftScanDeps) {
  const result = await getRepoVisibility(repo, {
    runCommand: async (cmd) => {
      try {
        return {
          success: true,
          stdout: await deps.gh(cmd.slice(1)),
          stderr: "",
        };
      } catch (err) {
        return { success: false, stdout: "", stderr: String(err) };
      }
    },
  });
  return result.ok && result.value === "public";
}

interface ExistingIssue {
  number: number;
  state: string;
  closedAt?: string | null;
  body: string;
  author?: { login?: string | null } | null;
}

async function fileGroup(
  group: RepeatedFailure,
  route: ShiftLeftRoute,
  deps: ShiftLeftScanDeps,
): Promise<void> {
  const previous = deps.ledger.filings[group.key];
  if (
    previous && deps.nowMs - previous.lastWriteMs < SHIFT_LEFT_WRITE_INTERVAL_MS
  ) return;
  const target = route.target === "vibecoder" ? deps.vibeCoderRepo : group.repo;
  let disclose = route.target === "product";
  if (!disclose) {
    disclose = true;
    for (const repo of group.repos ?? [group.repo]) {
      if (!await isPublic(repo, deps)) disclose = false;
    }
  }
  const rows = (await deps.gh([
    "api",
    `search/issues?q=${
      encodeURIComponent(
        `repo:${target} is:issue in:body "${SHIFT_LEFT_MARKER_PREFIX}:${group.key}"`,
      )
    }&per_page=20`,
    "--jq",
    ".items[] | {number, state, closedAt: .closed_at, body, author: {login: .user.login}} | tojson",
  ])).split("\n").filter((l) => l.trim()).map((l) =>
    JSON.parse(l) as ExistingIssue
  ).filter((i) => parseShiftLeftMarker(i.body ?? "") === group.key);
  // A marker in an issue body is not evidence the fleet wrote it: on a
  // public repository anyone can plant one to silence this detector.
  const existing = await selectFleetAuthoredMatches(
    rows,
    "shift-left",
    { fleetAuthors: deps.fleetAuthors },
    deps.warn,
    "none is treated as this detector's issue, and a new one is filed",
  );
  const open = existing.find((i) => i.state.toUpperCase() === "OPEN");
  const where = route.target === "vibecoder" ? "VibeCoder" : group.repo;

  if (open) {
    const fresh = group.observations.filter((o) =>
      o.observedAtMs > (previous?.lastWriteMs ?? 0)
    );
    if (fresh.length === 0) return;
    if (!deps.execute) {
      deps.log(
        `shift-left: would comment on ${where} issue #${open.number} (${group.tool})`,
      );
      return;
    }
    await deps.withWriteScope(target, () =>
      deps.gh([
        "issue",
        "comment",
        String(open.number),
        "--repo",
        target,
        "--body",
        formatRecurrence(group, fresh, disclose),
      ]));
    deps.ledger.filings[group.key] = {
      targetRepo: target,
      issueNumber: open.number,
      lastWriteMs: deps.nowMs,
    };
    deps.log(
      `shift-left: recurrence noted on ${where} issue #${open.number} (${group.tool})`,
    );
    return;
  }

  let recurredAfter: number | undefined;
  const closed = existing
    .filter((i) => i.closedAt)
    .sort((a, b) => Date.parse(b.closedAt!) - Date.parse(a.closedAt!))[0];
  if (closed) {
    const after = await repeatedFailures(
      { ...deps.ledger, observations: group.observations },
      deps.nowMs,
      { sinceMs: Date.parse(closed.closedAt!) },
    );
    if (after.length === 0) return;
    recurredAfter = closed.number;
  }
  const { title, body } = formatShiftLeftIssue(group, route, {
    sourcePublic: disclose,
    recurredAfter,
  });
  if (!deps.execute) {
    deps.log(`shift-left: would file in ${where}: ${title}`);
    return;
  }
  const labelArgs = guardedLabelArgs(
    // `idle-task` is the work label the worker may apply itself, so the
    // fleet picks the issue up without a human label (Issue #4610).
    ["idle-task", "enhancement"],
    "worker/deno/lib/shift_left_failures.ts",
  );
  const url = await deps.withWriteScope(target, () =>
    deps.gh([
      "issue",
      "create",
      "--repo",
      target,
      "--title",
      title,
      "--body",
      body,
      ...labelArgs,
    ]));
  const issueNumber = Number(/\/issues\/(\d+)\s*$/.exec(url.trim())?.[1]);
  deps.ledger.filings[group.key] = {
    targetRepo: target,
    issueNumber: Number.isFinite(issueNumber) ? issueNumber : undefined,
    lastWriteMs: deps.nowMs,
  };
  deps.log(
    `shift-left: filed ${where} issue ${url.trim()} (${group.tool}: ${route.reason})`,
  );
}

/**
 * One detector pass: observe new failures, then file or update an issue for
 * each repeated failure. A failure in one repository or group is logged and
 * the rest continue; the caller persists the ledger.
 */
export async function runShiftLeftScan(deps: ShiftLeftScanDeps): Promise<void> {
  for (const repo of deps.repos) {
    try {
      const { observations, resumeMs } = await observeRepo(repo, deps);
      recordObservations(deps.ledger, observations, deps.nowMs);
      deps.ledger.lastScanMs[repo] = resumeMs;
    } catch (error) {
      deps.warn(`shift-left scan of ${repo} failed: ${error}`);
    }
  }
  const gates = new Map<string, string | null>();
  const routed: { group: RepeatedFailure; route: ShiftLeftRoute }[] = [];
  for (const group of await repeatedFailures(deps.ledger, deps.nowMs)) {
    if (!deps.repos.includes(group.repo)) continue;
    try {
      if (!gates.has(group.repo)) {
        gates.set(group.repo, await readLocalGate(group.repo, deps));
      }
      routed.push({
        group,
        route: routeShiftLeftFix(
          group,
          gates.get(group.repo) ?? null,
          deps.babysitterLogins,
        ),
      });
    } catch (error) {
      deps.warn(
        `shift-left routing for ${group.tool} failed: ${error}`,
      );
    }
  }
  const generic = await genericGroups(routed);
  const covered = new Set(generic.map((g) => g.group.tool));
  const filings = [
    ...routed.filter(({ group, route }) =>
      !(route.target === "product" && covered.has(group.tool))
    ),
    ...generic,
  ];
  for (const { group, route } of filings) {
    try {
      await fileGroup(group, route, deps);
    } catch (error) {
      deps.warn(`shift-left filing for ${group.tool} failed: ${error}`);
    }
  }
}

export async function loadShiftLeftLedger(
  path: string,
): Promise<ShiftLeftLedger> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path));
    if (parsed?.version === 1 && Array.isArray(parsed.observations)) {
      return { ...emptyShiftLeftLedger(), ...parsed };
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.warn(
        `unreadable shift-left ledger ${path}; starting afresh: ${error}`,
      );
    }
  }
  return emptyShiftLeftLedger();
}

export async function saveShiftLeftLedger(
  path: string,
  ledger: ShiftLeftLedger,
): Promise<void> {
  const result = await atomicWrite({
    targetFile: path,
    content: JSON.stringify(ledger),
  });
  if (!result.ok) throw result.error;
}
