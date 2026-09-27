// Posts one /review-fleet-prs review (Issue #2678).
//
// Input: a JSON file { pr: <one "ready" entry from gate.ts>, review: <the
// Fable reply, as text or an object> }. The script decides the outcome,
// re-checks the head commit, posts the review, appends it to the review log,
// refreshes the summary, and raises a desktop notification when a PR is
// sent back or held for the owner.
//
// Usage: deno run --allow-run=gh,osascript --allow-read --allow-write
//          --allow-env=HOME post.ts --input=<file>
// Output: one line of JSON, { posted, outcome?, reason? }.
// Exit 2 when the review is malformed; nothing is posted and the PR comes
// back on the next gate pass.

import {
  decideOutcome,
  LOG_FILE,
  type LogRecord,
  parseFableReview,
  reviewBody,
  stateDir,
  writeSummary,
} from "./review_log.ts";

interface Input {
  pr: {
    repo: string;
    number: number;
    title: string;
    url: string;
    headSha: string;
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

async function main() {
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

  const now = await run("gh", [
    "pr",
    "view",
    String(pr.number),
    "-R",
    pr.repo,
    "--json",
    "headRefOid,state",
    "--jq",
    '"\\(.headRefOid) \\(.state)"',
  ]);
  if (now !== `${pr.headSha} OPEN`) {
    console.log(JSON.stringify({ posted: false, reason: `now ${now}` }));
    return;
  }

  const removed = pr.testChanges.removed;
  const outcome = decideOutcome(review, removed);
  const bodyFile = await Deno.makeTempFile({ suffix: ".md" });
  await Deno.writeTextFile(bodyFile, reviewBody(outcome, review, removed));
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
  };
  const dir = stateDir();
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
      "Fable sent a PR back",
      `${pr.repo}#${pr.number}: ${review.findings.length} finding(s)`,
    );
  } else if (outcome === "held") {
    await notify(
      "PR held for you",
      `${pr.repo}#${pr.number} changes existing tests`,
    );
  }
  console.log(JSON.stringify({ posted: true, outcome }));
}

if (import.meta.main) await main();
