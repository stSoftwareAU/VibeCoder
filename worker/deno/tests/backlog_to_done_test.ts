/**
 * Goal 1, as a behaviour test: a backlog finishes unattended (Issue #2547).
 *
 * The owner's goal: "raise 100s of issues over many repositories and have a
 * weekend off and on Monday it's all done." Each scenario seeds a backlog
 * into an in-memory GitHub, runs the worker's real selection and close-out
 * code tick by tick (`fixtures/backlog_sim.ts`), and asserts the goal
 * directly — every issue closed, and no invariant breached on the way.
 *
 * Every scenario after the first is a live incident. A regression that
 * breaks goal 1 fails here even when every gate's own tests stay green,
 * which is how #2473 (a dependant labelled `needs-human`) and #824 (an issue
 * left open after its PR merged) both shipped.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { FakeGitHub } from "./fixtures/fake_github.ts";
import {
  describe,
  runBacklog,
  type SimResult,
} from "./fixtures/backlog_sim.ts";

const REPO = "acme/app";

function assertFinishedCleanly(result: SimResult): void {
  const summary = describe(result);
  assertEquals(result.violations, [], summary);
  assertEquals(result.finished, true, summary);
}

Deno.test("backlog-to-done - a dependency chain the fleet works end to end finishes (Issue #2547)", async () => {
  const fake = new FakeGitHub({ startIso: "2026-09-20T00:00:00Z" });
  fake.addIssue({ repo: REPO, title: "Root", labels: ["work-on"] });
  fake.addIssue({
    repo: REPO,
    title: "Middle",
    labels: ["work-on"],
    body: "Depends on #1",
  });
  fake.addIssue({
    repo: REPO,
    title: "Leaf",
    labels: ["work-on"],
    body: "Depends on #2",
  });

  const result = await runBacklog(fake, { repos: [REPO] });

  assertFinishedCleanly(result);
  assertEquals(result.claims, [`${REPO}#1`, `${REPO}#2`, `${REPO}#3`]);
});

Deno.test("backlog-to-done - a chain whose root a human merged into the milestone branch finishes (#824, #2532)", async () => {
  // GRQ-AutoTrader 2026-09-23: the owner's PR #838 merged into the milestone
  // branch with `Closes #824`. GitHub closes nothing on a milestone-branch
  // merge, the close-out sweep only read the host's own PRs (#2537), so #824
  // stayed open all day. Its dependants were dependency-blocked; under #2473
  // they were labelled `needs-human` — VibeCoder #2532 and, by contagion,
  // #2534 (#2545). Either way the chain never finished.
  const milestone = "Automatic buying from the score sheet";
  const fake = new FakeGitHub({ startIso: "2026-09-22T21:00:00Z" });
  fake.addIssue({
    repo: REPO,
    title: "trader: the deployed evaluation decides from the real observation",
    labels: ["top-priority"],
    milestone,
  });
  fake.addIssue({
    repo: REPO,
    title: "trader: classify every candidate",
    labels: ["top-priority"],
    milestone,
    body: "Depends on #1",
  });
  fake.addIssue({
    repo: REPO,
    title: "executor: place the approved proposal",
    labels: ["top-priority"],
    milestone,
    body: "Depends on #2",
  });
  fake.advance(60);
  const humanPr = fake.openPr({
    repo: REPO,
    title: "trader: the scheduled evaluation decides from the observation (#1)",
    body: "Closes #1\n\n## Summary\n",
    author: "owner",
    head: "issue-1-real-evaluation",
    base: "milestone/automatic-buying-from-the-score-sheet",
  });
  fake.mergePr(REPO, humanPr.number);

  const result = await runBacklog(fake, { repos: [REPO] });

  assertFinishedCleanly(result);
  // The root was finished by the human; the fleet must not redo it.
  assertEquals(result.claims, [`${REPO}#2`, `${REPO}#3`]);
});

Deno.test("backlog-to-done - top-priority work in one repo is claimed before older low-priority work in another (Issue #2547)", async () => {
  const fake = new FakeGitHub({ startIso: "2026-09-20T00:00:00Z" });
  fake.addIssue({
    repo: "acme/other",
    title: "Backlog chore",
    labels: ["low-priority"],
  });
  fake.advance(60);
  fake.addIssue({ repo: REPO, title: "Urgent fix", labels: ["top-priority"] });

  const result = await runBacklog(fake, { repos: ["acme/other", REPO] });

  assertFinishedCleanly(result);
  assertEquals(result.claims, [`${REPO}#1`, "acme/other#1"]);
});

Deno.test("backlog-to-done - a work-on chain the fleet works inside a milestone finishes (#2530 → #2532 → #2534)", async () => {
  // VibeCoder 2026-09-23: #2530's PR merged into its milestone branch and the
  // issue stayed open until the next close-out sweep. A scan in that window
  // saw a dependency "blocked by a merged PR"; #2473 labelled the dependant
  // #2532 `needs-human`, and #2534 caught the label from #2532 (#2545).
  const milestone = "#2527 worker deno lib: priority streams";
  const fake = new FakeGitHub({ startIso: "2026-09-23T08:00:00Z" });
  fake.addIssue({
    repo: REPO,
    title: "Let claims share a busy milestone stream",
    labels: ["work-on"],
    milestone,
  });
  fake.addIssue({
    repo: REPO,
    title: "Stop selection refusing top-priority for stream occupancy",
    labels: ["work-on"],
    milestone,
    body: "Depends on #1",
  });
  fake.addIssue({
    repo: REPO,
    title: "Record the concrete gate on every blocked candidate",
    labels: ["work-on"],
    milestone,
    body: "Depends on #2",
  });

  const result = await runBacklog(fake, { repos: [REPO] });

  assertFinishedCleanly(result);
  assertEquals(result.claims, [`${REPO}#1`, `${REPO}#2`, `${REPO}#3`]);
});
