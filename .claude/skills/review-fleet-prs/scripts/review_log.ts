// Review log and summary for /review-fleet-prs (Issue #2678).
//
// post.ts appends one record per posted review to log.jsonl; every gate pass
// rewrites summary.md from the log and the open-PR search it already makes,
// so keeping the owner informed costs no model tokens and no extra API calls.
// Both live beside the Vibe Coder's own logs (stateDir), outside the
// checkout, which the worker resets.

import {
  type FiledIssue,
  type Finding,
  type LogRecord,
  type Outcome,
  parseLog,
  type TestChangeNote,
} from "../../../../worker/deno/lib/fleet_review_log.ts";
export { parseLog } from "../../../../worker/deno/lib/fleet_review_log.ts";
export type {
  FiledIssue,
  Finding,
  LogRecord,
  Outcome,
  TestChangeKind,
  TestChangeNote,
} from "../../../../worker/deno/lib/fleet_review_log.ts";

import {
  hostLogDirPlatform,
  readConfiguredLogDirSync,
  resolveLogDir,
} from "../../../../worker/deno/lib/log_dir.ts";
import {
  checklistGapFindings,
  type ChecklistState,
  type ChecklistVerdict,
} from "../../../../worker/deno/lib/review_checklists.ts";
import type { EarlierVerdict } from "../../../../worker/deno/lib/earlier_findings.ts";
import {
  MAX_UNRELATED_ISSUES,
  parseReviewReply,
} from "../../../../worker/deno/lib/pre_pr_verifier.ts";
import { runFooter, type RunInfo } from "./review_cost.ts";
// Type only: test_change_policy.ts imports this module's values, so a value
// import back would be a cycle.
import type { ApprovedTestChange } from "./test_change_policy.ts";

export const REVIEW_MARKER = "Automated review by /review-fleet-prs";

/**
 * The version of the owner-hold policy a held review was made under. Version 2
 * is the #4655 evidence-review policy: a test change is never itself a hold, so
 * the owner is asked only about a product-contract question or a repo's
 * explicit override. Bumping it reassesses every existing reviewer-owned hold
 * once, including a hold at the current head (Issue #4643, Issue #4655).
 */
export const HOLD_POLICY_VERSION = 2;

// A held review carries its policy version on a line of its own, so the gate
// can tell a stale hold from a current one (Issue #4655). Only a whole line
// counts: the marker quoted in prose or a code span does not.
export const HOLD_POLICY_MARKER_PREFIX = "<!-- vibe-hold-policy v=";
const HOLD_POLICY_LINE = /^<!-- vibe-hold-policy v=(\d{1,4}) -->$/;

export function holdPolicyMarker(version = HOLD_POLICY_VERSION): string {
  return `${HOLD_POLICY_MARKER_PREFIX}${version} -->`;
}

/**
 * The policy version a held review body was made under: the last whole-line
 * marker in it (the skill's own marker comes after the reviewer's text), or 1
 * when there is none, which is a hold made before #4655.
 */
export function holdPolicyFromBody(body: string | undefined): number {
  let version = 1;
  for (const line of (body ?? "").split("\n")) {
    const match = HOLD_POLICY_LINE.exec(line.trim());
    if (match) version = Number(match[1]);
  }
  return version;
}

// A pre-existing problem Fable noticed that the PR did not cause (already on
// the base branch, unchanged by the PR): unfair to ask this PR to fix it, too
// important to forget, so post.ts files it as a new issue in the PR's repo
// instead of letting it block or hold the PR. A problem the PR causes is a
// finding, never one of these.
export interface UnrelatedIssue {
  title: string;
  body: string;
  file?: string;
  line?: number;
  /**
   * An open issue the reviewer found that already covers this defect class
   * (Issue #3598): the instance is added there as a comment, not filed anew.
   */
  existingIssue?: number;
}

export { MAX_UNRELATED_ISSUES };

// Structurally the same shape as the pre-PR verifier's ReviewReply (Issue #3395).
export interface FableReview {
  earlierFindings?: EarlierVerdict[];
  summary: string;
  findings: Finding[];
  // "tightened": an existing test's expectation changed only to make it
  // stricter; approved like "trivial".
  testChanges: "none" | "trivial" | "tightened" | "meaningful";
  testChangeNotes: TestChangeNote[];
  unrelatedIssues: UnrelatedIssue[];
  // Per-item verdicts for the repo's review checklists; [] when none apply
  // (Issue #3594).
  checklist: ChecklistVerdict[];
}

export const LOG_FILE = "log.jsonl";
export const SUMMARY_FILE = "summary.md";
export const OPEN_FILE = "open.json"; // PR keys the latest gate pass saw open

const DEFAULT_CONFIG = new URL("../../../../.config.json", import.meta.url);
const STATE_NAME = "review-fleet-prs";

// Beside the Vibe Coder's own logs: `<log_dir>/review-fleet-prs`, where
// `log_dir` is the `.config.json` key, else the platform default, resolved by
// the worker's own code so the two can never disagree.
// `env` is injectable so a test never has to mutate the process environment.
export function stateDir(
  configPath: string | URL = DEFAULT_CONFIG,
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): string {
  return `${
    resolveLogDir(
      env("HOME") ?? "",
      env,
      "posix",
      hostLogDirPlatform(),
      readConfiguredLogDirSync(
        configPath instanceof URL
          ? decodeURIComponent(configPath.pathname)
          : configPath,
      ),
    )
  }/${STATE_NAME}`;
}

// The skill used to keep everything in a hidden `~/.review-fleet-prs`. Moves
// each entry into `dir` once, so the review history (and with it "already
// reviewed" and earlier findings) carries over. An entry already in `dir` is
// never overwritten; the old directory is removed only once it is empty.
export async function migrateLegacyStateDir(
  dir: string,
  home: string | undefined = Deno.env.get("HOME"),
): Promise<void> {
  const legacy = `${home}/.${STATE_NAME}`;
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(legacy));
  } catch {
    return; // nothing to migrate
  }
  await Deno.mkdir(dir, { recursive: true });
  for (const entry of entries) {
    const to = `${dir}/${entry.name}`;
    try {
      await Deno.lstat(to);
      if (!entry.isDirectory) continue; // the log directory's copy wins
      // Both have it (rounds/): move what the log directory lacks.
      await migrateTree(`${legacy}/${entry.name}`, to);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      await Deno.rename(`${legacy}/${entry.name}`, to);
    }
  }
  try {
    await Deno.remove(legacy, { recursive: false });
  } catch {
    // Not empty: something was kept because the log directory had its own.
  }
}

async function migrateTree(from: string, to: string): Promise<void> {
  for await (const entry of Deno.readDir(from)) {
    try {
      await Deno.lstat(`${to}/${entry.name}`);
    } catch {
      await Deno.rename(`${from}/${entry.name}`, `${to}/${entry.name}`);
    }
  }
  try {
    await Deno.remove(from);
  } catch {
    // kept entries
  }
}

// Prints the directory, for run.sh.
if (import.meta.main) console.log(stateDir());

// GitHub spells a bot's login `slug[bot]` over REST but `slug` in GraphQL
// review authors, so a reviewer App must match either spelling.
export const sameLogin = (a: string | undefined, b: string) =>
  a !== undefined && a.replace(/\[bot\]$/, "") === b.replace(/\[bot\]$/, "");

export const prKey = (repo: string, number: number) => `${repo}#${number}`;

// A reply that is not the JSON the review prompt asks for throws, so it posts
// nothing and the PR is retried next pass. A malformed checklist verdict inside
// an otherwise valid reply is dropped by `parseChecklistVerdicts` instead of
// throwing: its item reaches `withChecklistGaps` as unreported, so the PR is
// sent back, never approved. The parser is shared with the pre-PR verifier
// (Issue #3395).
export function parseFableReview(text: string): FableReview {
  const r = parseReviewReply(text);
  return { ...r, unrelatedIssues: r.unrelatedIssues.map(keepValidExisting) };
}

// The shared parser keeps `existingIssue` as the reviewer wrote it. Only a
// positive whole number names an issue; anything else is dropped, so the
// finding is filed as new rather than commented somewhere wrong (Issue #3598).
function keepValidExisting(i: UnrelatedIssue): UnrelatedIssue {
  const { existingIssue, ...rest } = i;
  return Number.isInteger(existingIssue) && existingIssue! > 0
    ? { ...rest, existingIssue }
    : rest;
}

const normTitle = (t: string) =>
  t.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?:;]+$/, "");

// Whether an open issue already covers an unrelated issue, so a re-review of
// the same PR does not file it twice.
export const sameIssueTitle = (a: string, b: string) =>
  normTitle(a) === normTitle(b);

/**
 * The reviewer's body without a footer it may have copied from earlier
 * filings, so the footer is written exactly once (Issue #3598).
 */
function withoutFooter(body: string): string {
  return body.split("\n").filter((line) => {
    const t = line.trim();
    return !/^Found while reviewing \S+, but outside that PR's scope\.?$/.test(
      t,
    ) &&
      t !== `_${REVIEW_MARKER}._`;
  }).join("\n").trim();
}

/** `file:line: ` ahead of an unrelated issue's body, when it names one. */
function unrelatedWhere(issue: UnrelatedIssue): string {
  return issue.file
    ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`: `
    : "";
}

export function unrelatedIssueBody(
  issue: UnrelatedIssue,
  pr: { repo: string; number: number; url: string },
): string {
  return [
    `${unrelatedWhere(issue)}${withoutFooter(issue.body)}`,
    "",
    `Found while reviewing ${pr.url}, but outside that PR's scope.`,
    "",
    `_${REVIEW_MARKER}._`,
  ].join("\n");
}

// Adds the blocking findings the code owes for a checklist that was not
// applied: a load problem, or an item the reply gave no verdict (Issue #3594).
// Done before decideOutcome, so such a review is never approved and the
// problem is named in the posted body whatever the model replied.
export function withChecklistGaps(
  review: FableReview,
  state: ChecklistState,
): FableReview {
  const gaps = checklistGapFindings(state, review.checklist);
  return gaps.length === 0
    ? review
    : { ...review, findings: [...review.findings, ...gaps] };
}

/**
 * The comment that adds a new instance of a defect class to the open issue
 * that already covers it (Issue #3598).
 */
export function unrelatedInstanceComment(
  issue: UnrelatedIssue,
  pr: { repo: string; number: number; url: string },
): string {
  return [
    `Another instance of this defect class, found while reviewing ${pr.url} (outside that PR's scope): **${issue.title}**`,
    "",
    `${unrelatedWhere(issue)}${withoutFooter(issue.body)}`,
    "",
    `_${REVIEW_MARKER}._`,
  ].join("\n");
}

// A test change is never itself a hold (Issue #4655): the evidence review
// decides it, and `hold` is set only when that review (or a repo's override)
// leaves a product-contract question for the owner. Findings and a missing
// checklist item still send the PR back first.
export function decideOutcome(
  review: FableReview,
  // Not a reason to hold (Issue #4655): kept so each caller names what it passes.
  _removedTests: readonly string[],
  opts: { hold?: boolean } = {},
): Outcome {
  if (review.findings.length > 0) return "changes_requested";
  // A checklist item the reviewer found missing blocks, even if it forgot to
  // add the matching finding (Issue #3594).
  if (review.checklist.some((c) => c.verdict === "missing")) {
    return "changes_requested";
  }
  if (opts.hold === true) return "held";
  return "approved";
}

// Untrusted text (a repo's checklist wording, the reviewer's note) on one
// line, with markdown/HTML/mention metacharacters neutralised.
function plain(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim()
    .replace(/[`<>@]/g, (c) => c === "`" ? "'" : c === "@" ? "@\u200b" : " ");
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const VERDICT_MARK: Record<ChecklistVerdict["verdict"], string> = {
  "met": "✅ met",
  "missing": "❌ missing",
  "not applicable": "➖ not applicable",
};

function checklistLines(review: FableReview): string[] {
  if (review.checklist.length === 0) return [];
  const lines = ["### Repository review checklists"];
  const names = [...new Set(review.checklist.map((c) => c.checklist))];
  for (const name of names) {
    lines.push("", `**${plain(name, 200)}**`);
    for (const c of review.checklist.filter((v) => v.checklist === name)) {
      const note = c.note.trim() === "" ? "" : `: ${plain(c.note)}`;
      lines.push(`- ${plain(c.item, 300)} — ${VERDICT_MARK[c.verdict]}${note}`);
    }
  }
  return lines;
}

function testNotes(review: FableReview, removedTests: readonly string[]) {
  return [
    ...removedTests.map((f) => `- \`${f}\`: test file removed.`),
    ...review.testChangeNotes.map((n) =>
      `- \`${n.file}:${n.line}\`: ${n.change}`
    ),
  ];
}

export function reviewBody(
  outcome: Outcome,
  review: FableReview,
  removedTests: readonly string[],
  filed: readonly FiledIssue[] = [],
  opts: {
    // `run`: the model run that wrote the review, for its run footer.
    run?: RunInfo;
    // The test changes the evidence review approved (Issue #4655); shown on an
    // approval only. Internal to this body: never printed as a field name.
    testReview?: { approved: readonly ApprovedTestChange[] };
    // Why the owner must decide (Issue #4655). `override`: the repo holds
    // every meaningful test change; otherwise `reasons` name the questions.
    hold?: { reasons: readonly string[]; override: boolean };
  } = {},
): string {
  const lines: string[] = [];
  if (outcome === "changes_requested") {
    for (const f of review.findings) {
      // Line 0: a finding about a whole check, not a line (Issue #3142).
      const at = f.line > 0 ? `${f.file}:${f.line}` : f.file;
      lines.push(`**\`${at}\`**: ${f.problem}`);
      if (f.fix) lines.push("", `**Fix:** ${f.fix}`);
      lines.push("");
    }
    const notes = testNotes(review, removedTests);
    if (notes.length > 0) {
      lines.push("Also note these changes to existing tests:", ...notes, "");
    }
    lines.push(review.summary);
  } else if (outcome === "held") {
    const hold = opts.hold;
    lines.push(
      hold?.override
        ? "Held for owner review: this repository holds every meaningful test change for the owner (pr_reviewer_test_hold_repos)."
        : "Held for owner review: the intended product contract behind these test changes is unclear.",
      ...(hold?.override
        ? []
        : (hold?.reasons ?? []).map((r) => `- ${plain(r)}`)),
      "",
      ...testNotes(review, removedTests),
      "",
      review.summary,
      "",
      // Its own line: the gate reads the policy version from it (Issue #4655).
      holdPolicyMarker(),
      "",
      "Approve to merge or request changes; then remove `needs-human`.",
    );
  } else if (
    outcome === "approved" && (opts.testReview?.approved.length ?? 0) > 0
  ) {
    lines.push(
      "Test changes reviewed against the approved test-change policy (Issue #4655): each is shown with the evidence the reviewer script verified at the head commit.",
      "",
      ...(opts.testReview?.approved ?? []).map((a) =>
        `- \`${plain(a.file)}:${a.line}\` (${plain(a.kind, 60)}): obsolete: ${
          plain(a.obsolete)
        }; remaining: ${plain(a.remaining)}; coverage: ${
          a.coverage.map((c) => plain(c)).join(", ")
        }; requirement: ${plain(a.requirement)}; verification: ${
          plain(a.verification)
        }`
      ),
      "",
      review.summary,
    );
  } else {
    lines.push(review.summary);
  }
  const checklist = checklistLines(review);
  if (checklist.length > 0) lines.push("", ...checklist);
  if (filed.length > 0) {
    lines.push(
      "",
      "Filed separately, as they are outside this PR's scope:",
      ...filed.map((i) =>
        `- #${i.number} ${i.title}${
          i.addedTo ? " (added as a new instance)" : ""
        }`
      ),
    );
  }
  lines.push("", `_${REVIEW_MARKER}._`);
  // Which model wrote it and what it cost (review_cost.ts), after the marker
  // line, which stays as it was.
  if (opts.run) lines.push("", runFooter(opts.run));
  return lines.join("\n");
}

// Rewrites summary.md from the log and the latest open-PR set.
export async function writeSummary(
  dir: string,
  open?: ReadonlySet<string>,
  now = new Date(),
  // The test-change policy in force, for the summary's header (Issue #4655).
  policyLine?: string,
): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  const read = (f: string) => Deno.readTextFile(`${dir}/${f}`).catch(() => "");
  if (open) {
    await Deno.writeTextFile(`${dir}/${OPEN_FILE}`, JSON.stringify([...open]));
  } else {
    open = new Set(JSON.parse((await read(OPEN_FILE)) || "[]") as string[]);
  }
  const records = parseLog(await read(LOG_FILE));
  await Deno.writeTextFile(
    `${dir}/${SUMMARY_FILE}`,
    renderSummary(records, open, now, policyLine),
  );
}

export async function readLog(dir: string): Promise<LogRecord[]> {
  return parseLog(
    await Deno.readTextFile(`${dir}/${LOG_FILE}`).catch(() => ""),
  );
}

export function latestByPr(records: LogRecord[]): Map<string, LogRecord> {
  const latest = new Map<string, LogRecord>();
  for (const r of records) latest.set(prKey(r.repo, r.number), r);
  return latest;
}

// The findings of the review a re-review must check were fixed: those of the
// PR's latest review, if it sent the PR back.
export function previousFindings(
  records: LogRecord[],
  repo: string,
  number: number,
): Finding[] {
  const last = latestByPr(records).get(prKey(repo, number));
  return last?.outcome === "changes_requested" ? last.findings : [];
}

// Whether this skill's own log recorded a change-request outcome for this PR
// at this exact head commit. GitHub's DISMISSED review state cannot tell a
// stale-dismissed approval apart from a change request the worker claimed
// (and so dismissed) before pushing the fix; the log is the record of which
// it was (Issue #3079).
export function wasChangeRequestAt(
  records: LogRecord[],
  repo: string,
  number: number,
  headSha: string,
): boolean {
  return records.some((r) =>
    r.repo === repo && r.number === number && r.headSha === headSha &&
    r.outcome === "changes_requested"
  );
}

// The owner-hold policy version of the latest held record for this PR at this
// exact head commit, or null when there is none (Issue #4643). A record written
// before the holdPolicy field is version 1.
export function heldPolicyAt(
  records: LogRecord[],
  repo: string,
  number: number,
  headSha: string,
): number | null {
  let policy: number | null = null;
  for (const r of records) {
    if (
      r.repo === repo && r.number === number && r.headSha === headSha &&
      r.outcome === "held"
    ) {
      policy = r.holdPolicy ?? 1;
    }
  }
  return policy;
}

const clip = (s: string, max = 200) =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const DAY_MS = 24 * 60 * 60 * 1000;

function line(r: LogRecord, detail: string, open: boolean) {
  const when = r.at.slice(0, 16).replace("T", " ");
  const closed = open ? "" : " (no longer open)";
  return `- [${r.repo}#${r.number}](${r.url}) ${r.title}${closed}  \n  ${when} UTC: ${detail}`;
}

// open: the keys of PRs the latest gate pass saw open. A held or sent-back PR
// that is no longer open has been dealt with and drops out of its section.
export function renderSummary(
  records: LogRecord[],
  open: ReadonlySet<string>,
  now: Date,
  policyLine?: string,
): string {
  const latest = [...latestByPr(records).values()].sort((a, b) =>
    b.at.localeCompare(a.at)
  );
  const isOpen = (r: LogRecord) => open.has(prKey(r.repo, r.number));
  const recent = (r: LogRecord) =>
    now.getTime() - Date.parse(r.at) < 7 * DAY_MS;

  const held = latest.filter((r) => r.outcome === "held" && isOpen(r));
  const sentBack = latest.filter((r) =>
    r.outcome === "changes_requested" && isOpen(r)
  );
  const approved = latest.filter((r) => r.outcome === "approved" && recent(r));
  const day = records.filter((r) => now.getTime() - Date.parse(r.at) < DAY_MS);
  const count = (o: Outcome) => day.filter((r) => r.outcome === o).length;

  const out = [
    "# Fleet PR reviews",
    "",
    `Updated ${now.toISOString().slice(0, 16).replace("T", " ")} UTC. ` +
    `Last 24 h: ${count("approved")} approved, ` +
    `${count("changes_requested")} sent back, ${count("held")} held for you.`,
    ...(policyLine ? [`Test-change policy: ${policyLine}`] : []),
    "",
    `## Waiting for you (${held.length})`,
    "",
    ...(held.length
      ? held.map((r) => line(r, clip(r.summary), true))
      : ["None."]),
    "",
    `## Sent back to the fleet (${sentBack.length})`,
    "",
    ...(sentBack.length
      ? sentBack.map((r) =>
        line(
          r,
          r.findings.map((f) => `\`${f.file}:${f.line}\` ${clip(f.problem)}`)
            .join("; "),
          true,
        )
      )
      : ["None."]),
    "",
    `## Approved, last 7 days (${approved.length})`,
    "",
    ...(approved.length
      ? approved.map((r) =>
        line(
          r,
          (r.testChangesReviewed === true
            ? "(test changes reviewed) "
            // Historical, pre-#4655: the opt-in auto-release (Issue #3397)
            // wrote this on its approvals, so an old log still renders.
            : r.autoReleased === true
            ? "(auto-released: issue-required test change) "
            : "") + clip(r.summary),
          isOpen(r),
        )
      )
      : ["None."]),
    "",
  ];
  return out.join("\n");
}
