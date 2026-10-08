// Posts one /review-fleet-prs review (Issue #2678).
//
// Input: a JSON file { pr: <one "ready" entry from gate.ts>, review: <the
// Fable reply, as text or an object> }. The script decides the outcome,
// re-checks the head commit, posts the review, appends it to the review log,
// refreshes the summary, files an issue for each problem Fable noticed outside
// the PR's scope (skipping one an open issue already covers), labels a held
// PR `needs-human` and removes that label on a later approve/send-back only
// when its log shows it added it, brings an approved fleet PR that is behind
// its base up to date (review first, then update: Issue #3225), and raises a
// desktop notification when a PR is sent back or held for the owner.
//
// Usage: deno run --allow-run=gh,osascript --allow-read --allow-write
//          --allow-env=HOME,XDG_STATE_HOME post.ts --input=<file>
//          [--state-dir=<dir>]
// --state-dir names the review state directory outright. A round inside the
// worker container passes it (Issue #3293): there the host's log directory is
// mounted at another path, so the resolution stateDir() makes on the host
// would point somewhere else.
// Output: one line of JSON, { posted, outcome?, filedIssues?, labelError?,
// branchUpdated?, branchUpdateError?, reason? }.
// A failed label call leaves the review posted, is not retried, and is
// reported in `labelError`; a refused branch update likewise in
// `branchUpdateError` (the next gate pass retries it).
// Exit 2 when the review is malformed; nothing is posted and the PR comes
// back on the next gate pass.

import {
  decideOutcome,
  type FableReview,
  type FiledIssue,
  latestByPr,
  LOG_FILE,
  type LogRecord,
  type Outcome,
  parseFableReview,
  prKey,
  readLog,
  reviewBody,
  sameIssueTitle,
  stateDir,
  unrelatedIssueBody,
  writeSummary,
} from "./review_log.ts";
import { type LabelError, syncNeedsHumanLabel } from "./needs_human.ts";
import { type BranchUpdateResult, updateBranch } from "./branch_update.ts";

interface Input {
  pr: {
    repo: string;
    number: number;
    title: string;
    url: string;
    headSha: string;
    kind?: "dependabot" | "fleet";
    testChanges: { removed: string[]; edited: string[] };
  };
  review: unknown;
}

async function run(cmd: string, args: string[]) {
  const out = await new Deno.Command(cmd, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    const err = new TextDecoder().decode(out.stderr).trim();
    throw new Error(`${cmd} ${args.slice(0, 2).join(" ")}: ${err}`);
  }
  return new TextDecoder().decode(out.stdout).trim();
}

// Best effort: macOS only, and a missing notification must never stop a post.
async function notify(title: string, message: string) {
  if (Deno.build.os !== "darwin") return;
  await run("osascript", [
    "-e",
    "on run argv",
    "-e",
    "display notification (item 1 of argv) with title (item 2 of argv)",
    "-e",
    "end run",
    message,
    title,
  ]).catch(() => {});
}

// Best effort: a failure to file one issue never stops the review being
// posted. An issue already open under the same title is linked, not refiled.
async function fileUnrelatedIssues(
  pr: Input["pr"],
  review: FableReview,
): Promise<FiledIssue[]> {
  const filed: FiledIssue[] = [];
  for (const issue of review.unrelatedIssues) {
    try {
      const open: FiledIssue[] = JSON.parse(
        await run("gh", [
          "issue",
          "list",
          "-R",
          pr.repo,
          "--state",
          "open",
          "--search",
          `${issue.title} in:title`,
          "--json",
          "number,url,title",
        ]),
      );
      const existing = open.find((o) => sameIssueTitle(o.title, issue.title));
      if (existing) {
        filed.push(existing);
        continue;
      }
      const bodyFile = await Deno.makeTempFile({ suffix: ".md" });
      await Deno.writeTextFile(bodyFile, unrelatedIssueBody(issue, pr));
      const url = await run("gh", [
        "issue",
        "create",
        "-R",
        pr.repo,
        "--title",
        issue.title,
        "--body-file",
        bodyFile,
      ]);
      await Deno.remove(bodyFile).catch(() => {});
      filed.push({
        number: Number(url.split("/").pop()),
        url,
        title: issue.title,
      });
    } catch (e) {
      console.error(`could not file "${issue.title}": ${(e as Error).message}`);
    }
  }
  return filed;
}

export function postedResult(
  outcome: Outcome,
  filedIssues: readonly FiledIssue[],
  labelError?: LabelError,
  branchUpdate?: BranchUpdateResult,
) {
  return {
    posted: true,
    outcome,
    filedIssues: filedIssues.map((i) => i.url),
    ...(labelError ? { labelError } : {}),
    ...(branchUpdate?.updated === true ? { branchUpdated: true } : {}),
    ...(branchUpdate?.updated === false
      ? { branchUpdateError: branchUpdate.error }
      : {}),
  };
}

// Review first, then up to date (Issue #3225): every fleet PR is armed with
// auto-merge on CI green, approved and branch up to date, so an approval of
// a PR that is behind its base would otherwise sit unmerged until something
// else brought it up to date. Dependabot branches are never pushed to.
export function shouldUpdateBranch(
  outcome: Outcome,
  kind: Input["pr"]["kind"],
  mergeStateStatus: string | undefined,
): boolean {
  return outcome === "approved" && kind !== "dependabot" &&
    mergeStateStatus === "BEHIND";
}

// Exported, not just `import.meta.main`-gated, so the root-level forwarding
// shim (Issue #3299 continuity gap — PR #3417 review) can call this same
// body for a runner still started from the pre-move layout.
export async function main() {
  const inputPath = Deno.args.find((a) => a.startsWith("--input="))?.slice(8);
  if (!inputPath) throw new Error("--input=<file> is required");
  const { pr, review: raw }: Input = JSON.parse(
    await Deno.readTextFile(inputPath),
  );
  let review;
  try {
    review = parseFableReview(
      typeof raw === "string" ? raw : JSON.stringify(raw),
    );
  } catch (e) {
    console.log(
      JSON.stringify({ posted: false, reason: (e as Error).message }),
    );
    Deno.exit(2);
  }

  // Unrelated issues are pre-existing on the base branch, so they stand
  // whether or not the PR has since moved or merged: file them before the
  // head check, or a PR that merges mid-review loses the bug Fable found.
  const filedIssues = await fileUnrelatedIssues(pr, review);
  const live: {
    headRefOid: string;
    state: string;
    mergeStateStatus?: string;
  } = JSON.parse(
    await run("gh", [
      "pr",
      "view",
      String(pr.number),
      "-R",
      pr.repo,
      "--json",
      "headRefOid,state,mergeStateStatus",
    ]),
  );
  if (live.headRefOid !== pr.headSha || live.state !== "OPEN") {
    console.log(
      JSON.stringify({
        posted: false,
        reason: `now ${live.headRefOid} ${live.state}`,
        filedIssues: filedIssues.map((i) => i.url),
      }),
    );
    return;
  }

  const removed = pr.testChanges.removed;
  const outcome = decideOutcome(review, removed);
  const dir = Deno.args.find((a) => a.startsWith("--state-dir="))?.slice(12) ??
    stateDir();
  const previous = latestByPr(await readLog(dir)).get(
    prKey(pr.repo, pr.number),
  );
  const bodyFile = await Deno.makeTempFile({ suffix: ".md" });
  await Deno.writeTextFile(
    bodyFile,
    reviewBody(outcome, review, removed, filedIssues),
  );
  const flag = outcome === "approved"
    ? "--approve"
    : outcome === "held"
    ? "--comment"
    : "--request-changes";
  await run("gh", [
    "pr",
    "review",
    String(pr.number),
    "-R",
    pr.repo,
    flag,
    "--body-file",
    bodyFile,
  ]);
  await Deno.remove(bodyFile).catch(() => {});

  const label = await syncNeedsHumanLabel(
    outcome,
    previous,
    pr,
    (args) => run("gh", args),
  );
  if (label.labelError) {
    console.error(
      `could not ${label.labelError.action} needs-human on ${pr.repo}#${pr.number}: ${label.labelError.error}`,
    );
  }

  let branchUpdate: BranchUpdateResult | undefined;
  if (shouldUpdateBranch(outcome, pr.kind, live.mergeStateStatus)) {
    branchUpdate = await updateBranch(pr, (args) => run("gh", args));
    if (!branchUpdate.updated) {
      console.error(
        `could not bring ${pr.repo}#${pr.number} up to date: ${branchUpdate.error}`,
      );
    }
  }

  const record: LogRecord = {
    at: new Date().toISOString(),
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    headSha: pr.headSha,
    outcome,
    summary: review.summary,
    findings: review.findings,
    testChangeNotes: review.testChangeNotes,
    removedTests: removed,
    filedIssues,
    addedNeedsHuman: label.addedNeedsHuman,
  };
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/${LOG_FILE}`,
    JSON.stringify(record) + "\n",
    {
      append: true,
    },
  );
  await writeSummary(dir);

  if (outcome === "changes_requested") {
    await notify(
      "Reviewer sent a PR back",
      `${pr.repo}#${pr.number}: ${review.findings.length} finding(s)`,
    );
  } else if (outcome === "held") {
    await notify(
      "PR held for you",
      `${pr.repo}#${pr.number} changes existing tests`,
    );
  }
  console.log(
    JSON.stringify(
      postedResult(outcome, filedIssues, label.labelError, branchUpdate),
    ),
  );
}

if (import.meta.main) await main();
