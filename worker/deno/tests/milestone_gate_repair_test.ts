/**
 * Unit tests for the gate-repair rung's own decisions (Issue #1965).
 *
 * The end-to-end fixture proves a repair carries a sync through; these prove
 * what the loop does when it does not. Every one of these branches ends the
 * cycle, so each must say what actually happened: a run that failed, a run the
 * worker ended and a repair that changed nothing are repairs that **ran**,
 * and only a rung that was never asked is "not attempted".
 *
 * Real git repositories where the tree matters — the fold reads and rewrites
 * the index, and a stub of git proves nothing about it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  describeRepairEscalation,
  gateRepairBudgetExhausted,
  readMergedCommitSubjects,
  repairGatedResolution,
} from "../lib/milestone_gate_repair.ts";
import type { MilestoneConflictAgentFn } from "../lib/milestone_conflict_ladder.ts";
import type { MergeGateOutcome } from "../lib/milestone_merge_gate.ts";

async function gitOk(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = new TextDecoder();
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${decode.decode(out.stderr)}`,
    );
  }
  return decode.decode(out.stdout);
}

interface Repo {
  dir: string;
  /** The commit the repair folds into. */
  mergeSha: string;
  preMergeSha: string;
  cleanup: () => Promise<void>;
}

/** A repository with two commits, the second standing in for the merge. */
async function repo(): Promise<Repo> {
  const dir = await Deno.makeTempDir({ prefix: "gate-repair-" });
  await gitOk(["init", "--initial-branch=main", "."], dir);
  await gitOk(["config", "user.email", "t@example.com"], dir);
  await gitOk(["config", "user.name", "Test"], dir);
  await Deno.writeTextFile(`${dir}/src.ts`, "export const a = 1;\n");
  await gitOk(["add", "-A"], dir);
  await gitOk(["commit", "-m", "Seed"], dir);
  const preMergeSha = (await gitOk(["rev-parse", "HEAD"], dir)).trim();
  await Deno.writeTextFile(`${dir}/src.ts`, "export const a = 2;\n");
  await gitOk(["add", "-A"], dir);
  await gitOk(["commit", "-m", "Issue #284: the other side's change"], dir);
  return {
    dir,
    mergeSha: (await gitOk(["rev-parse", "HEAD"], dir)).trim(),
    preMergeSha,
    cleanup: async () => {
      try {
        await Deno.remove(dir, { recursive: true });
      } catch (err) {
        console.error(`could not remove ${dir}: ${err}`);
      }
    },
  };
}

const FAILURE: MergeGateOutcome = {
  status: "failed",
  detail: "deno task check in . failed (exit 1)",
  output: "TS2339: Property 'b' does not exist",
};

const PASSED: MergeGateOutcome = {
  status: "passed",
  detail: "deno task check passed",
  output: "",
};

/** A gate that always refuses, counting how often it was asked. */
function refusingGate(calls: { n: number }): () => Promise<MergeGateOutcome> {
  return () => {
    calls.n++;
    return Promise.resolve(FAILURE);
  };
}

Deno.test("repairGatedResolution - with no agent rung nothing is attempted, and it says so (Issue #1965)", async () => {
  const fx = await repo();
  try {
    const outcome = await repairGatedResolution({
      firstFailure: FAILURE,
      gate: () => Promise.resolve(FAILURE),
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/1965",
      defaultBranch: "main",
      mergeSha: fx.mergeSha,
      mergedCommitSubjects: [],
    });

    assertEquals(outcome.status, "not-attempted");
    assert(
      outcome.status === "not-attempted" &&
        outcome.detail.includes("no resolution agent"),
      "the reason names the missing rung",
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("repairGatedResolution - a merge commit that could not be read is not repaired (Issue #1965)", async () => {
  const fx = await repo();
  try {
    let asked = 0;
    const outcome = await repairGatedResolution({
      firstFailure: FAILURE,
      gate: () => Promise.resolve(FAILURE),
      agentFn: () => {
        asked++;
        return Promise.resolve({ ok: true, value: { terminated: false } });
      },
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/1965",
      defaultBranch: "main",
      mergeSha: "",
      mergedCommitSubjects: [],
    });

    assertEquals(outcome.status, "not-attempted");
    assertEquals(asked, 0, "no run is started with nowhere to fold it");
  } finally {
    await fx.cleanup();
  }
});

Deno.test("repairGatedResolution - a run that failed is a repair that ran, not one never attempted (Issue #1965)", async () => {
  const fx = await repo();
  try {
    const outcome = await repairGatedResolution({
      firstFailure: FAILURE,
      gate: () => Promise.resolve(FAILURE),
      agentFn: () =>
        Promise.resolve({ ok: false, error: new Error("the model refused") }),
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/1965",
      defaultBranch: "main",
      mergeSha: fx.mergeSha,
      mergedCommitSubjects: [],
    });

    assertEquals(outcome.status, "failed");
    assert(
      outcome.status === "failed" &&
        outcome.detail.includes("the model refused"),
      "the failure travels with it",
    );
    const note = describeRepairEscalation(FAILURE, outcome);
    assert(
      !note.includes("No repair was attempted"),
      `a run that happened is never reported as one that did not: ${note}`,
    );
    assertStringIncludes(note, FAILURE.output);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("repairGatedResolution - a run the worker ended is reported as ended, not as a verdict (Issue #1693)", async () => {
  const fx = await repo();
  try {
    const outcome = await repairGatedResolution({
      firstFailure: FAILURE,
      gate: () => Promise.resolve(FAILURE),
      agentFn: () => Promise.resolve({ ok: true, value: { terminated: true } }),
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/1965",
      defaultBranch: "main",
      mergeSha: fx.mergeSha,
      mergedCommitSubjects: [],
    });

    assertEquals(outcome.status, "failed");
    assert(
      outcome.status === "failed" &&
        outcome.detail.includes("ended by the worker"),
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("repairGatedResolution - a provider outage is reported as the provider's, not as a verdict (Issue #2613)", async () => {
  const fx = await repo();
  try {
    const outcome = await repairGatedResolution({
      firstFailure: FAILURE,
      gate: () => Promise.resolve(FAILURE),
      agentFn: () =>
        Promise.resolve({
          ok: true,
          value: {
            terminated: false,
            providerUnavailable: "API Error: 402 Insufficient Balance",
          },
        }),
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/1965",
      defaultBranch: "main",
      mergeSha: fx.mergeSha,
      mergedCommitSubjects: [],
    });

    assertEquals(outcome.status, "failed");
    const detail = outcome.status === "failed" ? outcome.detail : "";
    assertStringIncludes(detail, "provider was unavailable");
    assertStringIncludes(detail, "402 Insufficient Balance");
  } finally {
    await fx.cleanup();
  }
});

Deno.test("repairGatedResolution - a repair that changed nothing does not spend the gate again (Issue #1965)", async () => {
  const fx = await repo();
  try {
    const calls = { n: 0 };
    const outcome = await repairGatedResolution({
      firstFailure: FAILURE,
      gate: refusingGate(calls),
      agentFn: () =>
        Promise.resolve({ ok: true, value: { terminated: false } }),
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/1965",
      defaultBranch: "main",
      mergeSha: fx.mergeSha,
      mergedCommitSubjects: [],
    });

    assertEquals(outcome.status, "failed");
    assert(
      outcome.status === "failed" && outcome.detail.includes("changed nothing"),
    );
    assertEquals(
      calls.n,
      0,
      "the verification is not re-run over the same tree",
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("repairGatedResolution - a refused budget on the first round is a repair never attempted (Issue #1965)", async () => {
  const fx = await repo();
  try {
    const outcome = await repairGatedResolution({
      firstFailure: FAILURE,
      gate: () => Promise.resolve(FAILURE),
      agentFn: () =>
        Promise.resolve({
          ok: false,
          error: gateRepairBudgetExhausted("30s left, a repair needs 120s"),
        }),
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/1965",
      defaultBranch: "main",
      mergeSha: fx.mergeSha,
      mergedCommitSubjects: [],
    });

    assertEquals(outcome.status, "not-attempted");
    assertStringIncludes(
      describeRepairEscalation(FAILURE, outcome),
      "want of budget",
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("repairGatedResolution - rounds are bounded, and a passing round ends the loop (Issue #1965)", async () => {
  const fx = await repo();
  try {
    let runs = 0;
    let edits = 0;
    // Writes a file nothing in the tree carries yet, so every round really
    // changes the tree and the bound — not a no-op — is what stops the loop.
    const agentFn: MilestoneConflictAgentFn = async (request) => {
      runs++;
      edits++;
      await Deno.writeTextFile(
        `${request.workDir}/fix-${edits}.ts`,
        "export {};\n",
      );
      return { ok: true, value: { terminated: false } };
    };

    const stubborn = await repairGatedResolution({
      firstFailure: FAILURE,
      gate: () => Promise.resolve(FAILURE),
      agentFn,
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/1965",
      defaultBranch: "main",
      mergeSha: fx.mergeSha,
      mergedCommitSubjects: [],
      maxRounds: 2,
    });
    assertEquals(runs, 2, "bounded at two rounds a cycle");
    assertEquals(stubborn.status, "failed");
    assertEquals(
      stubborn.status === "failed" && stubborn.record.rounds[1]?.files,
      ["fix-2.ts"],
      "round two reports its own file, not round one's",
    );
    assert(
      stubborn.status === "failed" && stubborn.record.rounds.length === 2,
      "both rounds are recorded with what they touched",
    );

    runs = 0;
    let asked = 0;
    const repaired = await repairGatedResolution({
      firstFailure: FAILURE,
      gate: () => {
        asked++;
        return Promise.resolve(PASSED);
      },
      agentFn,
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/1965",
      defaultBranch: "main",
      mergeSha: fx.mergeSha,
      mergedCommitSubjects: [],
      maxRounds: 2,
    });
    assertEquals(repaired.status, "repaired");
    assertEquals(runs, 1, "a tree the gate accepts ends the loop");
    assertEquals(asked, 1);
  } finally {
    await fx.cleanup();
  }
});

Deno.test("repairGatedResolution - a second round finishes what the first started (Issue #1965)", async () => {
  const fx = await repo();
  try {
    // The GRQ-AutoTrader#304 shape: reconciling the first semantic conflict
    // surfaces a second one, and the round that fixes it is the one that
    // passes.
    let round = 0;
    const agentFn: MilestoneConflictAgentFn = async (request) => {
      round++;
      await Deno.writeTextFile(
        `${request.workDir}/limits-${round}.ts`,
        `export const round = ${round};\n`,
      );
      return { ok: true, value: { terminated: false } };
    };
    const outcome = await repairGatedResolution({
      firstFailure: FAILURE,
      gate: () => Promise.resolve(round >= 2 ? PASSED : FAILURE),
      agentFn,
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/1965",
      defaultBranch: "main",
      mergeSha: fx.mergeSha,
      mergedCommitSubjects: [],
    });

    assertEquals(outcome.status, "repaired");
    assert(outcome.status === "repaired");
    assertEquals(outcome.record.rounds.length, 2);
    assertEquals(outcome.record.rounds[0]?.files, ["limits-1.ts"]);
    assertEquals(
      outcome.record.rounds[1]?.files,
      ["limits-2.ts"],
      "each round names what it itself changed",
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("repairGatedResolution - a repair that rewrites history is refused, not folded in (Issue #1965)", async () => {
  const fx = await repo();
  try {
    const outcome = await repairGatedResolution({
      firstFailure: FAILURE,
      gate: () => Promise.resolve(PASSED),
      // The agent "fixes" the build by reverting the other side wholesale.
      agentFn: async (request) => {
        await gitOk(["reset", "--hard", fx.preMergeSha], request.workDir);
        return { ok: true, value: { terminated: false } };
      },
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/1965",
      defaultBranch: "main",
      mergeSha: fx.mergeSha,
      mergedCommitSubjects: [],
    });

    assertEquals(outcome.status, "failed");
    assert(
      outcome.status === "failed" &&
        outcome.detail.includes("side-pick by another route"),
      `a rewound merge is refused by name: ${
        outcome.status === "failed" && outcome.detail
      }`,
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("repairGatedResolution - a verification that does not run buys no further round (Issue #1965)", async () => {
  const fx = await repo();
  try {
    let runs = 0;
    const outcome = await repairGatedResolution({
      firstFailure: FAILURE,
      gate: () =>
        Promise.resolve({
          status: "skipped" as const,
          detail: "no test:unit task",
          output: "",
        }),
      agentFn: async (request) => {
        runs++;
        await Deno.writeTextFile(`${request.workDir}/fix.ts`, "export {};\n");
        return { ok: true, value: { terminated: false } };
      },
      options: { cwd: fx.dir },
      milestoneBranch: "milestone/1965",
      defaultBranch: "main",
      mergeSha: fx.mergeSha,
      mergedCommitSubjects: [],
    });

    assertEquals(outcome.status, "failed");
    assertEquals(runs, 1, "a check that never runs is not worth a second run");
    assert(
      outcome.status === "failed" &&
        outcome.detail.includes("does not run"),
    );
    assertStringIncludes(outcome.gate.detail, "Issue #1559");
  } finally {
    await fx.cleanup();
  }
});

Deno.test("readMergedCommitSubjects - reads the other side's commits, bounded by the limit (Issue #1965)", async () => {
  const fx = await repo();
  try {
    assertEquals(
      await readMergedCommitSubjects(
        { cwd: fx.dir },
        fx.preMergeSha,
        "HEAD",
      ),
      ["Issue #284: the other side's change"],
    );
    assertEquals(
      (await readMergedCommitSubjects(
        { cwd: fx.dir },
        fx.preMergeSha,
        "HEAD",
        0,
      ))
        .length,
      0,
      "the limit bounds what the prompt carries",
    );
  } finally {
    await fx.cleanup();
  }
});

Deno.test("readMergedCommitSubjects - an unknown side or an unreadable log degrades to no context, and says so (Issue #1965)", async () => {
  const fx = await repo();
  const warnings: string[] = [];
  const logger = {
    info: () => {},
    warn: (message: string) => warnings.push(message),
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  try {
    assertEquals(
      await readMergedCommitSubjects({ cwd: fx.dir }, "", "HEAD", 20, logger),
      [],
    );
    assertEquals(
      await readMergedCommitSubjects(
        { cwd: fx.dir },
        "0000000000000000000000000000000000000000",
        "HEAD",
        20,
        logger,
      ),
      [],
    );
    assertEquals(
      warnings.length,
      2,
      "both degradations are reported, not silent",
    );
  } finally {
    await fx.cleanup();
  }
});
