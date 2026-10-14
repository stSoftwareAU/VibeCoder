/**
 * Guidance ledger for review-fleet-prs (Issue #3539, part of #3396).
 *
 * Step 3 files guidance issues for recurring review findings. This ledger
 * records each one against its target pattern, records the blocking findings
 * that still match that pattern, and reports the guidance whose window has
 * passed with the pattern recurring, so the loop proposes removing or
 * rewriting it instead of adding more.
 *
 * Matching a finding to a pattern is the model's judgement (step 3); this
 * script does only the deterministic bookkeeping: counting, windows and issue
 * state. A `gh` failure or a malformed ledger line exits non-zero with the
 * reason; it is never read as "no recurrence".
 *
 * SIMPLE-ON-PURPOSE: the ledger is per machine, like everything else under
 * `<logs>/review-fleet-prs/`; upgrade when the loop runs on more than one
 * machine.
 *
 *   deno run --allow-run=gh --allow-read --allow-write --allow-env guidance.ts track --issue=<n> --pattern=<slug>
 *   ... guidance.ts hit --pattern=<slug> --pr=<owner/repo#n>
 *   ... guidance.ts due [--window-days=30]
 *   ... guidance.ts retire --issue=<n> --by=<issue>
 *
 * Uses Australian English throughout.
 */

import { stateDir } from "./review_log.ts";

export const LEDGER_FILE = "guidance.jsonl";
/** Where guidance issues are filed (SKILL.md step 3). */
export const GUIDANCE_REPO = "stSoftwareAU/VibeCoder";
export const DEFAULT_WINDOW_DAYS = 30;
/** Step 3's recurrence threshold: at least two independent PRs. */
export const RECURRENCE_PRS = 2;

const DAY_MS = 86_400_000;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const PR_REF = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[1-9]\d*$/;

export type LedgerRecord =
  | { kind: "track"; issue: number; pattern: string; at: string }
  | { kind: "hit"; pattern: string; pr: string; at: string }
  | { kind: "retire"; issue: number; by: number; at: string };

export type RunGh = (args: string[]) => Promise<string>;

export type DueStatus = "pending" | "dropped" | "recurring" | "held";

export interface DueEntry {
  issue: number;
  pattern: string;
  status: DueStatus;
  closedAt: string | null;
  /** Distinct PRs with a matching hit after the guidance closed. */
  independentPrs: number;
}

const isIssue = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;
const isTime = (v: unknown): v is string =>
  typeof v === "string" && !Number.isNaN(Date.parse(v));

/** Validate one parsed ledger line, or say what is wrong with it. */
function checkRecord(r: unknown): LedgerRecord | string {
  if (typeof r !== "object" || r === null) return "not an object";
  const o = r as Record<string, unknown>;
  if (!isTime(o.at)) return "missing or invalid `at`";
  switch (o.kind) {
    case "track":
      if (!isIssue(o.issue)) return "track needs a positive whole `issue`";
      if (typeof o.pattern !== "string" || !SLUG.test(o.pattern)) {
        return "track needs a lower-case slug `pattern`";
      }
      return { kind: "track", issue: o.issue, pattern: o.pattern, at: o.at };
    case "hit":
      if (typeof o.pattern !== "string" || !SLUG.test(o.pattern)) {
        return "hit needs a lower-case slug `pattern`";
      }
      if (typeof o.pr !== "string" || !PR_REF.test(o.pr)) {
        return "hit needs `pr` as owner/repo#n";
      }
      return { kind: "hit", pattern: o.pattern, pr: o.pr, at: o.at };
    case "retire":
      if (!isIssue(o.issue) || !isIssue(o.by)) {
        return "retire needs positive whole `issue` and `by`";
      }
      return { kind: "retire", issue: o.issue, by: o.by, at: o.at };
    default:
      return `unknown kind ${JSON.stringify(o.kind)}`;
  }
}

/** Parse the ledger; throws naming the first malformed line. */
export function parseLedger(text: string): LedgerRecord[] {
  const records: LedgerRecord[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`${LEDGER_FILE} line ${i + 1}: not valid JSON`);
    }
    const checked = checkRecord(parsed);
    if (typeof checked === "string") {
      throw new Error(`${LEDGER_FILE} line ${i + 1}: ${checked}`);
    }
    records.push(checked);
  });
  return records;
}

/** Read the ledger in `dir`; a machine with no ledger yet has no records. */
export async function readLedger(dir: string): Promise<LedgerRecord[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(`${dir}/${LEDGER_FILE}`);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  return parseLedger(text);
}

/** Append one validated record to the ledger in `dir`. */
export async function appendRecord(
  dir: string,
  record: LedgerRecord,
): Promise<void> {
  const checked = checkRecord(record);
  if (typeof checked === "string") {
    throw new Error(`invalid record: ${checked}`);
  }
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/${LEDGER_FILE}`,
    `${JSON.stringify(checked)}\n`,
    { append: true },
  );
}

/**
 * Classify each tracked guidance issue that has not been retired:
 * - **pending:** still open;
 * - **dropped:** closed as not planned;
 * - **recurring:** closed as completed at least `windowDays` ago, with hits
 *   since the close from at least two independent PRs;
 * - **held:** otherwise.
 *
 * Rejects on a `gh` failure, naming the issue.
 */
export async function due(
  records: readonly LedgerRecord[],
  gh: RunGh,
  now: Date = new Date(),
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<DueEntry[]> {
  const retired = new Set(
    records.flatMap((r) => r.kind === "retire" ? [r.issue] : []),
  );
  // The latest track record per issue names its pattern.
  const tracked = new Map<number, string>();
  for (const r of records) {
    if (r.kind === "track" && !retired.has(r.issue)) {
      tracked.set(r.issue, r.pattern);
    }
  }
  const entries: DueEntry[] = [];
  for (const [issue, pattern] of tracked) {
    let state: { state?: unknown; stateReason?: unknown; closedAt?: unknown };
    try {
      state = JSON.parse(
        await gh([
          "issue",
          "view",
          String(issue),
          "-R",
          GUIDANCE_REPO,
          "--json",
          "state,stateReason,closedAt",
        ]),
      );
    } catch (e) {
      throw new Error(
        `could not read guidance issue #${issue}: ${(e as Error).message}`,
      );
    }
    if (state.state === "OPEN") {
      entries.push({
        issue,
        pattern,
        status: "pending",
        closedAt: null,
        independentPrs: 0,
      });
      continue;
    }
    if (state.state !== "CLOSED" || !isTime(state.closedAt)) {
      throw new Error(
        `guidance issue #${issue}: unexpected state ${JSON.stringify(state)}`,
      );
    }
    const closedAt = state.closedAt;
    if (state.stateReason === "NOT_PLANNED") {
      entries.push({
        issue,
        pattern,
        status: "dropped",
        closedAt,
        independentPrs: 0,
      });
      continue;
    }
    const closedMs = Date.parse(closedAt);
    const prs = new Set(
      records.flatMap((r) =>
        r.kind === "hit" && r.pattern === pattern && Date.parse(r.at) > closedMs
          ? [r.pr]
          : []
      ),
    );
    const windowPassed = now.getTime() - closedMs >= windowDays * DAY_MS;
    entries.push({
      issue,
      pattern,
      status: windowPassed && prs.size >= RECURRENCE_PRS ? "recurring" : "held",
      closedAt,
      independentPrs: prs.size,
    });
  }
  return entries;
}

function flag(args: readonly string[], name: string): string | undefined {
  return args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function wholeFlag(args: readonly string[], name: string): number {
  const raw = flag(args, name);
  const n = Number(raw);
  if (raw === undefined || !Number.isInteger(n) || n <= 0) {
    throw new Error(`--${name}=<positive whole number> is required`);
  }
  return n;
}

async function runGh(args: string[]): Promise<string> {
  const out = await new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(new TextDecoder().decode(out.stderr).trim());
  }
  return new TextDecoder().decode(out.stdout).trim();
}

async function main(args: string[]): Promise<void> {
  const dir = flag(args, "state-dir") ?? stateDir();
  const at = new Date().toISOString();
  switch (args[0]) {
    case "track":
      await appendRecord(dir, {
        kind: "track",
        issue: wholeFlag(args, "issue"),
        pattern: flag(args, "pattern") ?? "",
        at,
      });
      return;
    case "hit":
      await appendRecord(dir, {
        kind: "hit",
        pattern: flag(args, "pattern") ?? "",
        pr: flag(args, "pr") ?? "",
        at,
      });
      return;
    case "retire":
      await appendRecord(dir, {
        kind: "retire",
        issue: wholeFlag(args, "issue"),
        by: wholeFlag(args, "by"),
        at,
      });
      return;
    case "due": {
      const window = flag(args, "window-days") === undefined
        ? DEFAULT_WINDOW_DAYS
        : wholeFlag(args, "window-days");
      const entries = await due(
        await readLedger(dir),
        runGh,
        new Date(),
        window,
      );
      console.log(JSON.stringify({ due: entries }));
      return;
    }
    default:
      throw new Error("usage: guidance.ts track|hit|due|retire [flags]");
  }
}

if (import.meta.main) {
  try {
    await main(Deno.args);
  } catch (e) {
    console.error(`guidance.ts: ${(e as Error).message}`);
    Deno.exit(1);
  }
}
