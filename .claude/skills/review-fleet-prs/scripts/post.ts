// Posts one /review-fleet-prs review (Issue #2678).
//
// Input: a JSON file { pr: <one "ready" entry from gate.ts>, review: <the
// Fable reply, as text or an object> }. The script decides the outcome,
// re-checks the head commit, posts the review, appends it to the review log,
// refreshes the summary, files an issue for each problem Fable noticed outside
// the PR's scope (skipping one an open issue already covers), labels a held
// PR `needs-human` and removes that label on a later approve/send-back only
// when its log shows it added it, brings an approved fleet or Dependabot PR
// that is behind its base up to date (review first, then update: Issue #3225;
// a Dependabot PR has auto-merge armed first, Issue #3663), and raises a
// desktop notification when a PR is sent back or held for the owner.
//
// Usage: deno run --allow-run=gh,osascript --allow-read --allow-write
//          --allow-env=HOME,XDG_STATE_HOME post.ts --input=<file>
//          [--state-dir=<dir>] [--no-model]
// Every review ends with a run footer naming the model run that wrote it
// (review_cost.ts): a round's input file sits in the round's directory beside
// its attempt log, an input elsewhere is an interactive session's, and
// --no-model marks a review posted with no model run (an audit send-back).
// --state-dir names the review state directory outright. A round inside the
// worker container passes it (Issue #3293): there the host's log directory is
// mounted at another path, so the resolution stateDir() makes on the host
// would point somewhere else.
// An opted-in repo (`pr_reviewer_auto_release` in .config.json) has an
// issue-required test-change hold auto-released as an approval (Issue #3397).
// Output: one line of JSON, { posted, outcome?, filedIssues?, labelError?,
// branchUpdated?, branchUpdateError?, autoMergeArmed?, autoMergeError?,
// autoReleased?, autoReleaseHeld?, reason? }.
// A failed label call leaves the review posted, is not retried, and is
// reported in `labelError`; a refused branch update likewise in
// `branchUpdateError` (the next gate pass retries it), and a refused
// auto-merge in `autoMergeError` (the update is then skipped, and the next
// gate pass tries to arm it again, then updates it).
// Exit 2 when the review is malformed or the entry lacks `checklistState`;
// nothing is posted and the PR comes back on the next gate pass.

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
  unrelatedInstanceComment,
  type UnrelatedIssue,
  unrelatedIssueBody,
  withChecklistGaps,
  writeSummary,
} from "./review_log.ts";
import type { ChecklistState } from "../../../../worker/deno/lib/review_checklists.ts";
import {
  type LabelError,
  type RunGh,
  syncNeedsHumanLabel,
} from "./needs_human.ts";
import { loadAutoReleaseRepos, resolveAutoRelease } from "./auto_release.ts";
import { type BranchUpdateResult, updateBranch } from "./branch_update.ts";
import {
  armAutoMerge,
  autoMergeMethod,
  type MergeMethod,
} from "./dependabot.ts";
import { postRunInfo, recordPosted } from "./review_cost.ts";

interface Input {
  pr: {
    repo: string;
    number: number;
    title: string;
    url: string;
    headSha: string;
    kind?: "dependabot" | "fleet";
    testChanges: { removed: string[]; edited: string[] };
    // From the gate entry; required, so a stale entry fails loudly rather
    // than skipping the checklist checks (Issue #3594).
    checklistState: ChecklistState;
  };
  review: unknown;
}

// Parses the reviewer's reply and adds the blocking findings the code owes
// for a checklist that was not applied (Issue #3594). Throws on a malformed
// reply or a gate entry without `checklistState`.
export function reviewForPost(
  raw: unknown,
  pr: Pick<Input["pr"], "checklistState">,
): FableReview {
  const state = pr.checklistState as ChecklistState | undefined;
  if (
    typeof state !== "object" || state === null ||
    !Array.isArray(state.expected) ||
    (state.problem !== null && typeof state.problem !== "string")
  ) {
    throw new Error(
      "the gate entry has no valid checklistState; re-run gate.ts and pass its entry verbatim",
    );
  }
  return withChecklistGaps(
    parseFableReview(typeof raw === "string" ? raw : JSON.stringify(raw)),
    state,
  );
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
// An issue the reviewer named as covering the same defect class gets the new
// instance as a comment (Issue #3598); if that issue is closed or cannot be
// read, the finding is filed as new, never dropped. Exported, with `gh`
// injectable, for its tests.
export async function fileUnrelatedIssues(
  pr: Pick<Input["pr"], "repo" | "number" | "url">,
  review: FableReview,
  gh: (args: string[]) => Promise<string> = (args) => run("gh", args),
): Promise<FiledIssue[]> {
  const filed: FiledIssue[] = [];
  for (const issue of review.unrelatedIssues) {
    if (issue.existingIssue !== undefined) {
      const added = await addToExistingIssue(
        pr,
        issue,
        issue.existingIssue,
        gh,
      );
      if (added) {
        filed.push(added);
        continue;
      }
    }
    try {
      const open: FiledIssue[] = JSON.parse(
        await gh([
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
      const url = await gh([
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

/**
 * Comment a new instance onto the open issue the reviewer named, or return
 * null so the caller files it as a new issue instead.
 */
async function addToExistingIssue(
  pr: Pick<Input["pr"], "repo" | "number" | "url">,
  issue: UnrelatedIssue,
  number: number,
  gh: (args: string[]) => Promise<string>,
): Promise<FiledIssue | null> {
  try {
    const existing: {
      number: number;
      url: string;
      title: string;
      state: string;
    } = JSON.parse(
      await gh([
        "issue",
        "view",
        String(number),
        "-R",
        pr.repo,
        "--json",
        "number,url,title,state",
      ]),
    );
    if (existing.state !== "OPEN") return null;
    const bodyFile = await Deno.makeTempFile({ suffix: ".md" });
    await Deno.writeTextFile(bodyFile, unrelatedInstanceComment(issue, pr));
    try {
      await gh([
        "issue",
        "comment",
        String(number),
        "-R",
        pr.repo,
        "--body-file",
        bodyFile,
      ]);
    } finally {
      await Deno.remove(bodyFile).catch(() => {});
    }
    return {
      number: existing.number,
      url: existing.url,
      title: existing.title,
      addedTo: true,
    };
  } catch (e) {
    console.error(
      `could not add "${issue.title}" to #${number}, filing it instead: ${
        (e as Error).message
      }`,
    );
    return null;
  }
}

export function postedResult(
  outcome: Outcome,
  filedIssues: readonly FiledIssue[],
  labelError?: LabelError,
  branchUpdate?: BranchUpdateResult,
  autoReleased?: boolean,
  autoReleaseHeld?: readonly string[],
  autoMerge?: AutoMergeResult,
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
    ...(autoMerge?.armed === true ? { autoMergeArmed: autoMerge.method } : {}),
    ...(autoMerge?.armed === false ? { autoMergeError: autoMerge.error } : {}),
    ...(autoReleased ? { autoReleased: true } : {}),
    ...(autoReleaseHeld ? { autoReleaseHeld } : {}),
  };
}

const isNotOptedIn = (reasons: readonly string[]) =>
  reasons.length === 1 && reasons[0] === "repo not opted in";

// The outcome, with an issue-required test-change hold released when the repo
// opted in and every note checks out; any doubt keeps the hold (Issue #3397).
export async function decidePostOutcome(
  pr: { repo: string; number: number },
  review: FableReview,
  removedTests: readonly string[],
  repos: readonly string[],
  runGh: RunGh,
): Promise<
  {
    outcome: Outcome;
    autoReleased: boolean;
    autoReleaseReasons: string[];
    autoReleaseHeld?: string[];
  }
> {
  const { release, reasons } = await resolveAutoRelease(
    pr,
    review,
    removedTests,
    repos,
    runGh,
  );
  const outcome = decideOutcome(review, removedTests, { autoRelease: release });
  return {
    outcome,
    autoReleased: release && outcome === "approved",
    autoReleaseReasons: reasons,
    ...(outcome === "held" && !isNotOptedIn(reasons)
      ? { autoReleaseHeld: reasons }
      : {}),
  };
}

// Review first, then up to date (Issue #3225): every fleet PR is armed with
// auto-merge on CI green, approved and branch up to date, so an approval of
// a PR that is behind its base would otherwise sit unmerged until something
// else brought it up to date. Dependabot PRs are updated too (Issue #3663).
export function shouldUpdateBranch(
  outcome: Outcome,
  mergeStateStatus: string | undefined,
): boolean {
  return outcome === "approved" && mergeStateStatus === "BEHIND";
}

export type AutoMergeResult =
  | { armed: true; method: MergeMethod }
  | { armed: false; error: string };

// Arms auto-merge on a Dependabot PR before post.ts updates it (Issue #3663).
// The update makes a merge commit the approval does not cover, and the gate
// only arms a Dependabot PR the reviewer approved at its head, so arming after
// the update would wait for another review. Undefined when the repo does not
// allow auto-merge (the gate cannot arm it either). A refusal is reported,
// never thrown.
export async function armDependabotAutoMerge(
  pr: { repo: string; number: number },
  runGh: RunGh,
): Promise<AutoMergeResult | undefined> {
  const [owner, name] = pr.repo.split("/");
  try {
    const repo: {
      autoMergeAllowed: boolean;
      squashMergeAllowed: boolean;
      mergeCommitAllowed: boolean;
    } = JSON.parse(
      await runGh([
        "api",
        "graphql",
        "-f",
        "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){autoMergeAllowed squashMergeAllowed mergeCommitAllowed}}",
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "--jq",
        ".data.repository",
      ]),
    );
    if (repo.autoMergeAllowed === false) return undefined;
    const method = autoMergeMethod(repo);
    await armAutoMerge(pr, method, runGh);
    return { armed: true, method };
  } catch (e) {
    return { armed: false, error: (e as Error).message.split("\n")[0]! };
  }
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
    review = reviewForPost(raw, pr);
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
    autoMergeRequest?: unknown;
  } = JSON.parse(
    await run("gh", [
      "pr",
      "view",
      String(pr.number),
      "-R",
      pr.repo,
      "--json",
      "headRefOid,state,mergeStateStatus,autoMergeRequest",
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
  const repos = await loadAutoReleaseRepos();
  const { outcome, autoReleased, autoReleaseHeld } = await decidePostOutcome(
    pr,
    review,
    removed,
    repos,
    (args) => run("gh", args),
  );
  const dir = Deno.args.find((a) => a.startsWith("--state-dir="))?.slice(12) ??
    stateDir();
  const previous = latestByPr(await readLog(dir)).get(
    prKey(pr.repo, pr.number),
  );
  // The run footer: the round's attempt that is posting (its log sits beside
  // the input file in the round's directory), an interactive session, or no
  // model run at all. Its cost is added when the round ends (review_cost.ts).
  const roundDir = inputPath.includes("/")
    ? inputPath.replace(/\/[^/]*$/, "")
    : ".";
  const runInfo = await postRunInfo(roundDir, {
    noModel: Deno.args.includes("--no-model"),
  });
  const bodyFile = await Deno.makeTempFile({ suffix: ".md" });
  await Deno.writeTextFile(
    bodyFile,
    reviewBody(outcome, review, removed, filedIssues, {
      autoReleased,
      run: runInfo,
    }),
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
  if (runInfo.kind === "round") {
    // Best effort: an unrecorded review just keeps "cost unknown".
    await recordPosted(roundDir, {
      repo: pr.repo,
      number: pr.number,
      attempt: runInfo.attempt,
    }).catch((e) =>
      console.error(`could not record the posted review: ${e.message}`)
    );
  }

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

  let autoMerge: AutoMergeResult | undefined;
  let branchUpdate: BranchUpdateResult | undefined;
  if (shouldUpdateBranch(outcome, live.mergeStateStatus)) {
    if (pr.kind === "dependabot" && !live.autoMergeRequest) {
      autoMerge = await armDependabotAutoMerge(pr, (args) => run("gh", args));
    }
    if (autoMerge?.armed === false) {
      console.error(
        `could not arm auto-merge on ${pr.repo}#${pr.number}, so it is not brought up to date: ${autoMerge.error}`,
      );
    } else {
      branchUpdate = await updateBranch(pr, (args) => run("gh", args));
      if (!branchUpdate.updated) {
        console.error(
          `could not bring ${pr.repo}#${pr.number} up to date: ${branchUpdate.error}`,
        );
      }
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
    ...(autoReleased ? { autoReleased: true as const } : {}),
    ...(autoReleaseHeld ? { autoReleaseHeld } : {}),
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
      postedResult(
        outcome,
        filedIssues,
        label.labelError,
        branchUpdate,
        autoReleased,
        autoReleaseHeld,
        autoMerge,
      ),
    ),
  );
}

if (import.meta.main) await main();
