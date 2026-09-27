// Review log and summary for /review-fleet-prs (Issue #2678).
//
// post.ts appends one record per posted review to log.jsonl; every gate pass
// rewrites summary.md from the log and the open-PR search it already makes,
// so keeping the owner informed costs no model tokens and no extra API calls.
// Both live outside the checkout, which the worker resets.

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

export interface FableReview {
  summary: string;
  findings: Finding[];
  testChanges: "none" | "trivial" | "meaningful";
  testChangeNotes: TestChangeNote[];
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
}

export const LOG_FILE = "log.jsonl";
export const SUMMARY_FILE = "summary.md";
export const OPEN_FILE = "open.json"; // PR keys the latest gate pass saw open

export function stateDir(): string {
  return `${Deno.env.get("HOME")}/.review-fleet-prs`;
}

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
  if (!["none", "trivial", "meaningful"].includes(r.testChanges)) {
    throw new Error(`review JSON has testChanges=${r.testChanges}`);
  }
  return { ...r, testChangeNotes: r.testChangeNotes ?? [] };
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
    );
  } else {
    lines.push(review.summary);
  }
  lines.push("", `_${REVIEW_MARKER} (Fable)._`);
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
