/**
 * The `needs-human` label a held /review-fleet-prs PR carries (Issue #2927).
 */
import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  NEEDS_HUMAN,
  needsHumanAction,
  syncNeedsHumanLabel,
} from "../../../.claude/skills/review-fleet-prs/scripts/needs_human.ts";
import { postedResult } from "../../../.claude/skills/review-fleet-prs/scripts/post.ts";
import {
  type FableReview,
  type LogRecord,
  reviewBody,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";

const pr = { repo: "acme/widgets", number: 42 };

const logRecord = (over: Partial<LogRecord> = {}): LogRecord => ({
  at: "2026-01-01T00:00:00.000Z",
  repo: pr.repo,
  number: pr.number,
  title: "t",
  url: "https://example.com/pr/42",
  headSha: "abc",
  outcome: "held",
  summary: "s",
  findings: [],
  testChangeNotes: [],
  removedTests: [],
  ...over,
});

function fakeGh(
  opts: { throwOn?: "add" | "remove"; labels?: string[] } = {},
) {
  const calls: string[][] = [];
  const run = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args.includes("view")) {
      return Promise.resolve(
        JSON.stringify({
          labels: (opts.labels ?? []).map((name) => ({ name })),
        }),
      );
    }
    if (
      opts.throwOn &&
      args.includes(
        opts.throwOn === "add" ? "--add-label" : "--remove-label",
      )
    ) {
      return Promise.reject(new Error(`gh failed: ${opts.throwOn}`));
    }
    return Promise.resolve("");
  };
  return { calls, run };
}

Deno.test("needsHumanAction: held always adds; otherwise removes only if the skill's own record added it", () => {
  assertEquals(needsHumanAction("held", undefined), "add");
  assertEquals(needsHumanAction("approved", undefined), undefined);
  assertEquals(needsHumanAction("changes_requested", undefined), undefined);
  assertEquals(
    needsHumanAction("approved", logRecord({ addedNeedsHuman: false })),
    undefined,
  );
  assertEquals(
    needsHumanAction("approved", logRecord({ addedNeedsHuman: true })),
    "remove",
  );
  assertEquals(
    needsHumanAction("changes_requested", logRecord({ addedNeedsHuman: true })),
    "remove",
  );
});

Deno.test("syncNeedsHumanLabel: held adds the label once", async () => {
  const { calls, run } = fakeGh();
  const result = await syncNeedsHumanLabel("held", undefined, pr, run);
  assertEquals(calls.length, 2);
  assert(calls[0]?.includes("view"));
  const args = calls[1] ?? [];
  assert(args.includes("--add-label"));
  assert(args.includes(NEEDS_HUMAN));
  assert(args.includes(String(pr.number)));
  assert(args.includes("-R"));
  assert(args.includes(pr.repo));
  assertEquals(result.addedNeedsHuman, true);
  assertEquals(result.labelError, undefined);
});

Deno.test("syncNeedsHumanLabel: an already-present label is never claimed as added, and is never later removed", async () => {
  const { calls, run } = fakeGh({ labels: [NEEDS_HUMAN] });
  const result = await syncNeedsHumanLabel("held", undefined, pr, run);
  assertEquals(calls.length, 1);
  assert(calls[0]?.includes("view"));
  assertEquals(result.addedNeedsHuman, false);
  assertEquals(result.labelError, undefined);

  // A later approve must not strip a label this skill never added.
  const laterRecord = logRecord({
    outcome: "held",
    addedNeedsHuman: result.addedNeedsHuman,
  });
  const { calls: laterCalls, run: laterRun } = fakeGh();
  const later = await syncNeedsHumanLabel(
    "approved",
    laterRecord,
    pr,
    laterRun,
  );
  assertEquals(laterCalls.length, 0);
  assertEquals(later.addedNeedsHuman, false);
});

Deno.test("syncNeedsHumanLabel: a non-lower-case canonical label (e.g. Needs-Human) is matched case-insensitively and never later removed", async () => {
  const { calls, run } = fakeGh({ labels: ["Needs-Human"] });
  const result = await syncNeedsHumanLabel("held", undefined, pr, run);
  assertEquals(calls.length, 1);
  assert(calls[0]?.includes("view"));
  assertEquals(result.addedNeedsHuman, false);

  const laterRecord = logRecord({
    outcome: "held",
    addedNeedsHuman: result.addedNeedsHuman,
  });
  const { calls: laterCalls, run: laterRun } = fakeGh();
  await syncNeedsHumanLabel("approved", laterRecord, pr, laterRun);
  assertEquals(laterCalls.length, 0);
});

Deno.test("syncNeedsHumanLabel: approved/changes_requested with no skill-added label makes no call", async () => {
  for (const outcome of ["approved", "changes_requested"] as const) {
    for (
      const previous of [
        undefined,
        logRecord({ outcome: "held" }),
        logRecord({ outcome: "held", addedNeedsHuman: false }),
      ]
    ) {
      const { calls, run } = fakeGh();
      const result = await syncNeedsHumanLabel(outcome, previous, pr, run);
      assertEquals(calls.length, 0);
      assertEquals(result.addedNeedsHuman, false);
      assertEquals(result.labelError, undefined);
    }
  }
});

Deno.test("syncNeedsHumanLabel: approved/changes_requested removes a skill-added label", async () => {
  for (const outcome of ["approved", "changes_requested"] as const) {
    const { calls, run } = fakeGh();
    const previous = logRecord({ outcome: "held", addedNeedsHuman: true });
    const result = await syncNeedsHumanLabel(outcome, previous, pr, run);
    assertEquals(calls.length, 1);
    const args = calls[0] ?? [];
    assert(args.includes("--remove-label"));
    assert(args.includes(NEEDS_HUMAN));
    assertEquals(result.addedNeedsHuman, false);
    assertEquals(result.labelError, undefined);
  }
});

Deno.test("syncNeedsHumanLabel: a failing add reports labelError without a retry", async () => {
  const { calls, run } = fakeGh({ throwOn: "add" });
  const result = await syncNeedsHumanLabel("held", undefined, pr, run);
  assertEquals(calls.length, 2);
  assertEquals(result.labelError?.action, "add");
  assert(result.labelError?.error.includes("gh failed"));
  assertEquals(result.addedNeedsHuman, false);
});

Deno.test("syncNeedsHumanLabel: a failing remove reports labelError and keeps addedNeedsHuman true", async () => {
  const { calls, run } = fakeGh({ throwOn: "remove" });
  const previous = logRecord({ outcome: "held", addedNeedsHuman: true });
  const result = await syncNeedsHumanLabel(
    "approved",
    previous,
    pr,
    run,
  );
  assertEquals(calls.length, 1);
  assertEquals(result.labelError?.action, "remove");
  assert(result.labelError?.error.includes("gh failed"));
  assertEquals(result.addedNeedsHuman, true);
});

Deno.test("postedResult: includes labelError only when given", () => {
  const filed = [{ number: 1, url: "https://example.com/i/1", title: "x" }];
  const withError = postedResult("held", filed, {
    action: "add",
    error: "boom",
  });
  const roundTripped = JSON.parse(JSON.stringify(withError));
  assertEquals(roundTripped.labelError, { action: "add", error: "boom" });

  const withoutError = postedResult("approved", filed);
  assertFalse("labelError" in JSON.parse(JSON.stringify(withoutError)));
});

const review = (over: Partial<FableReview> = {}): FableReview => ({
  summary: "Looks right.",
  findings: [],
  testChanges: "none",
  testChangeNotes: [],
  unrelatedIssues: [],
  ...over,
});

Deno.test("reviewBody: only the held body mentions removing needs-human", () => {
  const held = reviewBody(
    "held",
    review({ testChanges: "meaningful" }),
    [],
  );
  assert(held.includes("then remove `needs-human`"));

  const approved = reviewBody("approved", review(), []);
  const sentBack = reviewBody(
    "changes_requested",
    review({
      findings: [{ file: "a.ts", line: 1, problem: "bug" }],
    }),
    [],
  );
  assertFalse(approved.includes("needs-human"));
  assertFalse(sentBack.includes("needs-human"));
});
