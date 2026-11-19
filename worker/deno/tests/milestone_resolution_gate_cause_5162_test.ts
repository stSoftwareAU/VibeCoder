/**
 * A refused resolution names the gate's cause (Issue #5162).
 *
 * The merged-tree path named the cause (Issue #4847); the resolution path
 * dropped it, so the filed merge-fallback issue said only that the gate
 * refused. Real git repositories and the real sync, judge and filing text.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import {
  isConflictEscalation,
  MilestoneConflictEscalation,
} from "../lib/milestone_conflict_triage.ts";
import type {
  MergeGateCause,
  MergeGateFn,
  MergeGateOutcome,
} from "../lib/milestone_merge_gate.ts";
import {
  RESOLUTION_GATE_BUDGET_MS,
  type ResolutionTask,
  verifyResolvedTree,
} from "../lib/milestone_resolution_gate.ts";
import {
  escalateRepeatedRefusal,
  judgeSyncFailure,
  MERGE_GATE_REFUSED_RESOLUTION,
} from "../lib/milestone_branch_sync.ts";
import { MILESTONE_REFUSAL_CEILING } from "../lib/milestone_sync_streak.ts";
import {
  mergeFallbackCause,
  type MergeFallbackFiling,
} from "../lib/merge_fallback_issue.ts";

async function gitOk(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

/** A remote and clone with a milestone branch behind `main`. */
async function setup(): Promise<{ root: string; clone: string }> {
  const root = await Deno.makeTempDir({ prefix: "issue-5162-" });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;
  await gitOk(["init", "--bare", "-b", "main", remote], root);
  await gitOk(["clone", remote, clone], root);
  await gitOk(["config", "user.email", "t@example.com"], clone);
  await gitOk(["config", "user.name", "Test"], clone);
  await Deno.writeTextFile(`${clone}/README.md`, "seed\n");
  await gitOk(["add", "README.md"], clone);
  await gitOk(["commit", "-m", "seed"], clone);
  await gitOk(["push", "-u", "origin", "main"], clone);
  await gitOk(["checkout", "-b", "milestone/5162"], clone);
  await gitOk(["push", "-u", "origin", "milestone/5162"], clone);
  // main keeps every line of the milestone side, so the triage resolves it.
  await gitOk(["checkout", "main"], clone);
  await Deno.writeTextFile(`${clone}/shared.txt`, "shared line\nmain adds\n");
  await gitOk(["add", "shared.txt"], clone);
  await gitOk(["commit", "-m", "main edits shared"], clone);
  await gitOk(["push", "origin", "main"], clone);
  await gitOk(["checkout", "milestone/5162"], clone);
  await Deno.writeTextFile(`${clone}/shared.txt`, "shared line\n");
  await gitOk(["add", "shared.txt"], clone);
  await gitOk(["commit", "-m", "milestone edits shared"], clone);
  await gitOk(["push", "origin", "milestone/5162"], clone);
  return { root, clone };
}

const timedOutGate: MergeGateFn = () =>
  Promise.resolve({
    status: "failed" as const,
    detail: "the check timed out",
    output: "no output",
    cause: "check-timed-out" as const,
  });

function escalation(cause?: MergeGateCause): MilestoneConflictEscalation {
  return new MilestoneConflictEscalation(
    "gate refused",
    [],
    [],
    "sha",
    "gate output",
    "msha",
    undefined,
    cause,
  );
}

Deno.test("syncMilestoneBranchWithDefault - a refused resolution carries the gate's cause into the ledger reason (Issue #5162)", async () => {
  const fx = await setup();
  try {
    const result = await syncMilestoneBranchWithDefault(
      "milestone/5162",
      "main",
      { cwd: fx.clone },
      undefined,
      timedOutGate,
    );
    assert(!result.ok);
    assert(isConflictEscalation(result.error));
    assertEquals(result.error.gateCause, "check-timed-out");
    const verdict = judgeSyncFailure(result.error, true);
    assertEquals(
      verdict.reason,
      "the merge gate refused the resolution (the check timed out)",
    );
    assertEquals(verdict.outcome, "not-charged");
    assertEquals(verdict.refusal, true);
  } finally {
    await Deno.remove(fx.root, { recursive: true }).catch(() => {});
  }
});

Deno.test("judgeSyncFailure - a refused resolution names a failed check (Issue #5162)", () => {
  assertEquals(
    judgeSyncFailure(escalation("tree-check-failed"), true).reason,
    "the merge gate refused the resolution (the repository's check failed)",
  );
});

Deno.test("judgeSyncFailure - an older escalation with no cause, or a forged one, gives the bare reason (Issue #5162)", () => {
  assertEquals(
    judgeSyncFailure(escalation(), true).reason,
    MERGE_GATE_REFUSED_RESOLUTION,
  );
  assertEquals(
    judgeSyncFailure(
      escalation("rm -rf" as unknown as MergeGateCause),
      true,
    ).reason,
    "the merge gate refused the resolution",
  );
});

Deno.test("mergeFallbackCause - a climbed resolution refusal names the gate's cause (Issue #5162)", () => {
  const verdict = judgeSyncFailure(escalation("tree-check-failed"), true);
  const climbed = escalateRepeatedRefusal(verdict, MILESTONE_REFUSAL_CEILING);
  const event: MergeFallbackFiling = {
    target: {
      kind: "milestone",
      repo: "acme/secret-trading",
      milestoneBranch: "milestone/5162",
      defaultBranch: "main",
    },
    conflictedFiles: [],
    runs: [{
      run: 1,
      host: "vibe-coder-6674",
      timings: [{ stage: "merge", seconds: 0 }],
      analysis:
        `Concluded \`failed\` at 2026-11-15T13:54:33.721Z: ${climbed.reason}`,
    }],
    behindBy: 0,
    fallbackAction: "Nothing was reverted.",
  };
  assertEquals(
    mergeFallbackCause(event),
    "the merge gate refused the resolution (the repository's check failed)",
  );
});

const passingTypeCheck: MergeGateFn = () =>
  Promise.resolve({
    status: "passed" as const,
    detail: "deno task check passed",
    output: "",
  });

type StepResult = { code: number; output: string; timedOut?: boolean };

/** Run the production gate over a temp tree with a `test:unit` task. */
async function resolutionGate(
  runner: (task: ResolutionTask) => Promise<StepResult>,
  options: {
    typeCheck?: MergeGateFn;
    now?: () => number;
    missingDir?: boolean;
  } = {},
): Promise<MergeGateOutcome> {
  const dir = await Deno.makeTempDir({ prefix: "issue-5162-gate-" });
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ tasks: { "test:unit": "deno test" } }),
    );
    return await verifyResolvedTree(
      options.missingDir ? `${dir}/absent` : dir,
      runner,
      options.typeCheck ?? passingTypeCheck,
      options.now,
      () => Promise.resolve(false),
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("verifyResolvedTree - a unit task exiting 1 is a tree-check-failed refusal (Issue #5162)", async () => {
  const outcome = await resolutionGate(() =>
    Promise.resolve({ code: 1, output: "boom" })
  );
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.cause, "tree-check-failed");
});

Deno.test("verifyResolvedTree - a unit task killed at its time limit is check-timed-out (Issue #5162)", async () => {
  const outcome = await resolutionGate(() =>
    Promise.resolve({ code: 124, output: "timed out", timedOut: true })
  );
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.cause, "check-timed-out");
});

Deno.test("verifyResolvedTree - a runner that throws is check-could-not-run (Issue #5162)", async () => {
  const outcome = await resolutionGate(() =>
    Promise.reject(new Error("spawn"))
  );
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.cause, "check-could-not-run");
});

Deno.test("verifyResolvedTree - a missing tree is tree-unreadable (Issue #5162)", async () => {
  const outcome = await resolutionGate(
    () => Promise.resolve({ code: 0, output: "" }),
    { missingDir: true },
  );
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.cause, "tree-unreadable");
});

Deno.test("verifyResolvedTree - an exhausted budget is check-timed-out (Issue #5162)", async () => {
  let t = 0;
  const outcome = await resolutionGate(
    () => Promise.resolve({ code: 0, output: "" }),
    { now: () => (t += RESOLUTION_GATE_BUDGET_MS + 1) },
  );
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.cause, "check-timed-out");
});

Deno.test("verifyResolvedTree - a type-check failure passed through keeps its cause (Issue #5162)", async () => {
  const outcome = await resolutionGate(
    () => Promise.resolve({ code: 0, output: "" }),
    { typeCheck: timedOutGate },
  );
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.cause, "check-timed-out");
});
