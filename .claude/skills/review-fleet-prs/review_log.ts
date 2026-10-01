// Review log and summary for /review-fleet-prs (Issue #2678).
//
// post.ts appends one record per posted review to log.jsonl; every gate pass
// rewrites summary.md from the log and the open-PR search it already makes,
// so keeping the owner informed costs no model tokens and no extra API calls.
// Both live beside the Vibe Coder's own logs (stateDir), outside the
// checkout, which the worker resets.

import {
  hostLogDirPlatform,
  readConfiguredLogDirSync,
  resolveLogDir,
} from "../../../worker/deno/lib/log_dir.ts";

export const REVIEW_MARKER = "Automated review by /review-fleet-prs";

export type Outcome = "approved" | "changes_requested" | "held";

export interface Finding {
  file: string;
  line: number;
  problem: string;
  fix?: string;
}

export interface TestChangeNote {
  file: string;
  line: number;
  change: string;
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
}

export interface FiledIssue {
  number: number;
  url: string;
  title: string;
}

export const MAX_UNRELATED_ISSUES = 3;

export interface FableReview {
  summary: string;
  findings: Finding[];
  // "tightened": an existing test's expectation changed only to make it
  // stricter; approved like "trivial".
  testChanges: "none" | "trivial" | "tightened" | "meaningful";
  testChangeNotes: TestChangeNote[];
  unrelatedIssues: UnrelatedIssue[];
}

export interface LogRecord {
  at: string; // ISO time the review was posted
  repo: string;
  number: number;
  title: string;
  url: string;
  headSha: string;
  outcome: Outcome;
  summary: string;
  findings: Finding[];
  testChangeNotes: TestChangeNote[];
  removedTests: string[];
  filedIssues?: FiledIssue[];
  addedNeedsHuman?: boolean; // the skill's own needs-human label is on the PR after this review (Issue #2927)
}

export const LOG_FILE = "log.jsonl";
export const SUMMARY_FILE = "summary.md";
export const OPEN_FILE = "open.json"; // PR keys the latest gate pass saw open

const DEFAULT_CONFIG = new URL("../../../.config.json", import.meta.url);
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

// Throws on anything that is not the JSON the review prompt asks for, so a
// malformed reply posts nothing and the PR is retried next pass.
export function parseFableReview(text: string): FableReview {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON object in review");
  const r = JSON.parse(text.slice(start, end + 1));
  if (typeof r.summary !== "string" || !Array.isArray(r.findings)) {
    throw new Error("review JSON lacks summary or findings");
  }
  if (!["none", "trivial", "tightened", "meaningful"].includes(r.testChanges)) {
    throw new Error(`review JSON has testChanges=${r.testChanges}`);
  }
  return {
    ...r,
    testChangeNotes: r.testChangeNotes ?? [],
    unrelatedIssues: parseUnrelatedIssues(r.unrelatedIssues),
  };
}

// A malformed unrelated issue is dropped, never a reason to reject the review.
function parseUnrelatedIssues(raw: unknown): UnrelatedIssue[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((i): i is UnrelatedIssue =>
    typeof i === "object" && i !== null &&
    typeof i.title === "string" && i.title.trim() !== "" &&
    typeof i.body === "string" && i.body.trim() !== ""
  ).slice(0, MAX_UNRELATED_ISSUES);
}

const normTitle = (t: string) =>
  t.toLowerCase().replace(/\s+/g, " ").trim().replace(/[.!?:;]+$/, "");

// Whether an open issue already covers an unrelated issue, so a re-review of
// the same PR does not file it twice.
export const sameIssueTitle = (a: string, b: string) =>
  normTitle(a) === normTitle(b);

export function unrelatedIssueBody(
  issue: UnrelatedIssue,
  pr: { repo: string; number: number; url: string },
): string {
  const where = issue.file
    ? `\`${issue.file}${issue.line ? `:${issue.line}` : ""}\`: `
    : "";
  return [
    `${where}${issue.body}`,
    "",
    `Found while reviewing ${pr.url}, but outside that PR's scope.`,
    "",
    `_${REVIEW_MARKER}._`,
  ].join("\n");
}

export function decideOutcome(
  review: FableReview,
  removedTests: readonly string[],
): Outcome {
  if (review.findings.length > 0) return "changes_requested";
  if (review.testChanges === "meaningful" || removedTests.length > 0) {
    return "held";
  }
  return "approved";
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
): string {
  const lines: string[] = [];
  if (outcome === "changes_requested") {
    for (const f of review.findings) {
      lines.push(`**\`${f.file}:${f.line}\`**: ${f.problem}`);
      if (f.fix) lines.push("", `**Fix:** ${f.fix}`);
      lines.push("");
    }
    const notes = testNotes(review, removedTests);
    if (review.testChanges === "meaningful" || removedTests.length > 0) {
      lines.push("Also note these changes to existing tests:", ...notes, "");
    }
    lines.push(review.summary);
  } else if (outcome === "held") {
    lines.push(
      "Held for owner review: this PR changes existing tests.",
      "",
      ...testNotes(review, removedTests),
      "",
      review.summary,
      "",
      "Approve to merge or request changes; then remove `needs-human`.",
    );
  } else {
    lines.push(review.summary);
  }
  if (filed.length > 0) {
    lines.push(
      "",
      "Filed separately, as they are outside this PR's scope:",
      ...filed.map((i) => `- #${i.number} ${i.title}`),
    );
  }
  lines.push("", `_${REVIEW_MARKER}._`);
  return lines.join("\n");
}

// Rewrites summary.md from the log and the latest open-PR set.
export async function writeSummary(
  dir: string,
  open?: ReadonlySet<string>,
  now = new Date(),
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
    renderSummary(records, open, now),
  );
}

export async function readLog(dir: string): Promise<LogRecord[]> {
  return parseLog(
    await Deno.readTextFile(`${dir}/${LOG_FILE}`).catch(() => ""),
  );
}

export function parseLog(text: string): LogRecord[] {
  return text.split("\n").filter((l) => l.trim() !== "").flatMap((l) => {
    try {
      return [JSON.parse(l) as LogRecord];
    } catch {
      return []; // a torn last line from an interrupted write
    }
  });
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
      ? approved.map((r) => line(r, clip(r.summary), isOpen(r)))
      : ["None."]),
    "",
  ];
  return out.join("\n");
}
