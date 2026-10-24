/**
 * Issue #4130: a repeat worker-gate failure splits the parent issue into
 * sub-issues instead of being recorded as another repeat failure.
 *
 * These pin the contract `handleIssueFailure` gives the split engine: the hook
 * is called only for a repeat of a splittable gate, a split writes nothing to
 * the issue, and a refused or throwing split falls back to today's repeat
 * record with a logged reason.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { FailureCategory } from "../lib/failure_diagnosis.ts";
import { handleIssueFailure } from "../lib/label_failure.ts";
import type {
  HandleFailureOptions,
  RepeatGateSplitHook,
  RepeatGateSplitOutcome,
  RepeatGateSplitRequest,
} from "../lib/label_types.ts";

const REPO = "owner/repo";
const ISSUE = 42;
const FAILURE_MESSAGE = "PR summary gate refused: section 'Evidence' missing";
const SUB_ISSUE_URLS = [
  "https://github.com/owner/repo/issues/101",
  "https://github.com/owner/repo/issues/102",
];
const SPLIT_NOTES = ["planning split the parent into two sub-issues"];
const SPLIT_OUTCOME: RepeatGateSplitOutcome = {
  split: true,
  subIssueUrls: SUB_ISSUE_URLS,
  notes: SPLIT_NOTES,
};

const GATE_CATEGORIES: FailureCategory[] = [
  "summary_incomplete",
  "quality_check",
  "pre_push_gate",
  "security_fix_gate",
];

const NON_GATE_CATEGORIES: FailureCategory[] = [
  "timeout",
  "rate_limit",
  "unknown",
  "push_failure",
  "internal_error",
  "zero_output",
];

/**
 * A gh stub that reports `labelsOnIssue` for the labels view and records every
 * call. An empty string means the issue carries no `failed-once` (run 1).
 */
function ghStub(labelsOnIssue: string) {
  const calls: string[][] = [];
  const ghCommandFn = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(labelsOnIssue);
    }
    return Promise.resolve("");
  };
  return { calls, ghCommandFn };
}

/** A hook that records each request and answers with `outcome`. */
function recordingHook(outcome: RepeatGateSplitOutcome) {
  const requests: RepeatGateSplitRequest[] = [];
  const hook: RepeatGateSplitHook = (req) => {
    requests.push(req);
    return Promise.resolve(outcome);
  };
  return { hook, requests };
}

/** Runs the handler against the stub, with a throwaway label cache. */
async function handle(
  ghCommandFn: (args: string[]) => Promise<string>,
  options: Partial<HandleFailureOptions> & { category: FailureCategory },
) {
  const cacheDir = await Deno.makeTempDir({ prefix: "split-4130-" });
  try {
    return await handleIssueFailure({
      repo: REPO,
      issueNumber: ISSUE,
      githubUser: "vibe-bot",
      failureMessage: FAILURE_MESSAGE,
      ...options,
    }, { ghCommandFn, cacheDir });
  } finally {
    await Deno.remove(cacheDir, { recursive: true });
  }
}

/** Collects every console.warn line emitted while `fn` runs. */
async function captureWarnings<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

function issueCommentCalls(calls: string[][]): string[][] {
  return calls.filter((a) => a[0] === "issue" && a[1] === "comment");
}

function addLabelCalls(calls: string[][]): string[][] {
  return calls.filter((a) => a.includes("--add-label"));
}

function removeAssigneeCalls(calls: string[][]): string[][] {
  return calls.filter((a) => a.includes("--remove-assignee"));
}

/** REST label writes go through `gh api`; a split must make none. */
function restCalls(calls: string[][]): string[][] {
  return calls.filter((a) => a[0] === "api");
}

/** The body of the first issue comment, or `""` when none was posted. */
function commentBody(calls: string[][]): string {
  const comment = issueCommentCalls(calls)[0];
  if (!comment) return "";
  return comment[comment.indexOf("--body") + 1] ?? "";
}

// ---------------------------------------------------------------------------
// (a) A repeat gate failure splits, and writes nothing to the issue.
// ---------------------------------------------------------------------------

for (const category of GATE_CATEGORIES) {
  Deno.test(`handleIssueFailure - a repeat ${category} failure splits instead of recording (Issue #4130)`, async () => {
    const gh = ghStub("failed-once");
    const { hook, requests } = recordingHook(SPLIT_OUTCOME);

    const result = await handle(gh.ghCommandFn, {
      category,
      splitOnRepeatGate: hook,
    });

    if (!result.ok) throw result.error;
    assertEquals(requests, [{ category, gateOutput: FAILURE_MESSAGE }]);
    assertEquals(result.value.markedAsFailedOnce, false);
    assertEquals(result.value.split, {
      subIssueUrls: SUB_ISSUE_URLS,
      notes: SPLIT_NOTES,
    });
    assertEquals(issueCommentCalls(gh.calls), []);
    assertEquals(addLabelCalls(gh.calls), []);
    assertEquals(removeAssigneeCalls(gh.calls), []);
    assertEquals(restCalls(gh.calls), []);
  });
}

// ---------------------------------------------------------------------------
// (b) A first gate failure is recorded exactly as before (run 1 unchanged).
// ---------------------------------------------------------------------------

for (const category of GATE_CATEGORIES) {
  Deno.test(`handleIssueFailure - a first ${category} failure is recorded, never split (Issue #4130)`, async () => {
    const gh = ghStub("");
    const { hook, requests } = recordingHook(SPLIT_OUTCOME);

    const result = await handle(gh.ghCommandFn, {
      category,
      splitOnRepeatGate: hook,
    });

    if (!result.ok) throw result.error;
    assertEquals(requests.length, 0);
    assertEquals(result.value.markedAsFailedOnce, true);
    assertEquals(result.value.split, undefined);
    assertEquals(issueCommentCalls(gh.calls).length, 1);
    assertStringIncludes(commentBody(gh.calls), "First Attempt");
  });
}

// ---------------------------------------------------------------------------
// (c) Non-gate repeat failures never split, even with a hook supplied.
// ---------------------------------------------------------------------------

for (const category of NON_GATE_CATEGORIES) {
  Deno.test(`handleIssueFailure - a repeat ${category} failure is recorded, never split (Issue #4130)`, async () => {
    const gh = ghStub("failed-once");
    const { hook, requests } = recordingHook(SPLIT_OUTCOME);

    const result = await handle(gh.ghCommandFn, {
      category,
      splitOnRepeatGate: hook,
    });

    if (!result.ok) throw result.error;
    assertEquals(requests.length, 0);
    assertEquals(result.value.markedAsFailedOnce, true);
    assertEquals(result.value.split, undefined);
    assertStringIncludes(commentBody(gh.calls), "Repeat Attempt");
  });
}

// ---------------------------------------------------------------------------
// (d) A refused split falls back to the repeat record, and says why.
// ---------------------------------------------------------------------------

Deno.test("handleIssueFailure - a refused split records the repeat and warns with the reason (Issue #4130)", async () => {
  const gh = ghStub("failed-once");
  const { hook, requests } = recordingHook({
    split: false,
    reason: "planning published no sub-issues",
  });

  const { value: result, warnings } = await captureWarnings(() =>
    handle(gh.ghCommandFn, {
      category: "pre_push_gate",
      splitOnRepeatGate: hook,
    })
  );

  if (!result.ok) throw result.error;
  assertEquals(requests.length, 1);
  assertEquals(result.value.markedAsFailedOnce, true);
  assertEquals(result.value.split, undefined);
  assertStringIncludes(commentBody(gh.calls), "Repeat Attempt");

  const splitWarnings = warnings.filter((w) => w.includes("(Issue #4130)"));
  assertEquals(splitWarnings.length, 1);
  assertStringIncludes(
    splitWarnings[0] ?? "",
    "[label_manager] Warning: repeat gate failure on issue #42 in owner/repo was not split",
  );
  assertStringIncludes(
    splitWarnings[0] ?? "",
    "planning published no sub-issues",
  );
});

// ---------------------------------------------------------------------------
// (e) A throwing split falls back to the repeat record, and logs the throw.
// ---------------------------------------------------------------------------

Deno.test("handleIssueFailure - a split that throws records the repeat and warns with the thrown message (Issue #4130)", async () => {
  const gh = ghStub("failed-once");
  const hook: RepeatGateSplitHook = () =>
    Promise.reject(new Error("planning exploded"));

  const { value: result, warnings } = await captureWarnings(() =>
    handle(gh.ghCommandFn, {
      category: "summary_incomplete",
      splitOnRepeatGate: hook,
    })
  );

  if (!result.ok) throw result.error;
  assertEquals(result.value.markedAsFailedOnce, true);
  assertEquals(result.value.split, undefined);
  assertStringIncludes(commentBody(gh.calls), "Repeat Attempt");

  const splitWarnings = warnings.filter((w) => w.includes("(Issue #4130)"));
  assertEquals(splitWarnings.length, 1);
  assertStringIncludes(
    splitWarnings[0] ?? "",
    "split threw: planning exploded",
  );
});

// ---------------------------------------------------------------------------
// (f) No hook supplied: a repeat gate failure is recorded, and no split is
// attempted, so no split warning is emitted.
// ---------------------------------------------------------------------------

Deno.test("handleIssueFailure - a repeat gate failure without a split hook records the repeat (Issue #4130)", async () => {
  for (const category of GATE_CATEGORIES) {
    const gh = ghStub("failed-once");

    const { value: result, warnings } = await captureWarnings(() =>
      handle(gh.ghCommandFn, { category })
    );

    if (!result.ok) throw result.error;
    assertEquals(result.value.markedAsFailedOnce, true);
    assertEquals(result.value.split, undefined);
    assertStringIncludes(commentBody(gh.calls), "Repeat Attempt");
    assert(
      warnings.every((w) => !w.includes("(Issue #4130)")),
      `no split warning expected for ${category}, got: ${warnings.join(" | ")}`,
    );
  }
});
