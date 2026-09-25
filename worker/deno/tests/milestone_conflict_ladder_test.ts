/**
 * The conflict ladder's own rungs and its refusals (Issue #1777).
 *
 * Real git throughout — the questions here are all questions about a
 * conflicted index ("is this path still unmerged?", "did staging mark it
 * resolved?"), and a stub of git answers none of them honestly. The rules
 * rung and the agent rung are injected, so nothing runs a model.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  AGENT_PROVIDER_UNAVAILABLE,
  climbConflictLadder,
  hasConflictMarkers,
  listUnmergedPaths,
  type MilestoneConflictAgentRequest,
} from "../lib/milestone_conflict_ladder.ts";
import type { FileDecision } from "../lib/milestone_conflict_triage.ts";
import type { DeterministicConflictReport } from "../lib/dependency_conflict_apply.ts";
import { createConflictStageTimer } from "../lib/conflict_stage_timer.ts";

const PATH = "lib/rival.ts";

async function git(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = new TextDecoder();
  if (out.code !== 0 && !args.includes("merge")) {
    throw new Error(`git ${args.join(" ")}: ${decode.decode(out.stderr)}`);
  }
  return decode.decode(out.stdout);
}

/** A repository stopped mid-merge, with `PATH` conflicted. */
async function conflictedClone(): Promise<
  { dir: string; cleanup: () => Promise<void> }
> {
  const dir = await Deno.makeTempDir({ prefix: "issue-1777-ladder-" });
  await git(["init", "--initial-branch=main", "."], dir);
  await git(["config", "user.email", "t@example.com"], dir);
  await git(["config", "user.name", "Test"], dir);
  await Deno.mkdir(`${dir}/lib`, { recursive: true });
  await Deno.writeTextFile(`${dir}/${PATH}`, "const impl = 'seed';\n");
  await git(["add", "-A"], dir);
  await git(["commit", "-m", "Seed"], dir);

  await git(["checkout", "-b", "milestone/1777"], dir);
  await Deno.writeTextFile(`${dir}/${PATH}`, "const impl = 'branch';\n");
  await git(["commit", "-am", "The branch's design"], dir);

  await git(["checkout", "main"], dir);
  await Deno.writeTextFile(`${dir}/${PATH}`, "const impl = 'main';\n");
  await git(["commit", "-am", "Main's rival design"], dir);

  await git(["checkout", "milestone/1777"], dir);
  // Expected to conflict — that is the state under test.
  await git(["merge", "main", "--no-edit"], dir);

  return {
    dir,
    cleanup: () => Deno.remove(dir, { recursive: true }).catch(() => {}),
  };
}

/** The triage's verdict on `PATH`: it could not decide. */
const undecided: FileDecision[] = [{
  path: PATH,
  case: "rival-designs",
  action: "escalate",
  reason: "neither side contains the other",
}];

/** A rules rung that decides nothing, so everything reaches the agent. */
const rulesDeferEverything = (
  options: { conflictedFiles: readonly string[] },
): Promise<DeterministicConflictReport> =>
  Promise.resolve({
    resolved: [],
    deferred: options.conflictedFiles.map((path) => ({
      path,
      reason: "no deterministic rule handles this file",
    })),
  });

Deno.test("listUnmergedPaths - names the conflicted path", async () => {
  const fx = await conflictedClone();
  try {
    const listed = await listUnmergedPaths({ cwd: fx.dir });
    assert(listed.ok, "the listing must succeed in a real clone");
    assertEquals(listed.value, [PATH]);
  } finally {
    await fx.cleanup();
  }
});

Deno.test(
  "listUnmergedPaths - a listing git could not produce is an error, never an empty list",
  async () => {
    const dir = await Deno.makeTempDir({ prefix: "issue-1777-nogit-" });
    try {
      const listed = await listUnmergedPaths({ cwd: dir });
      assert(!listed.ok, "outside a repository the listing must fail loud");
      assertStringIncludes(
        listed.error.message,
        "unmerged paths could not be listed",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "hasConflictMarkers - reports a marker, reports a clean file, and fails loud outside a repository",
  async () => {
    const fx = await conflictedClone();
    try {
      const withMarkers = await hasConflictMarkers([PATH], { cwd: fx.dir });
      assert(withMarkers.ok);
      assertEquals(withMarkers.value, true, "the merge left markers in place");

      await Deno.writeTextFile(`${fx.dir}/${PATH}`, "const impl = 'both';\n");
      const cleaned = await hasConflictMarkers([PATH], { cwd: fx.dir });
      assert(cleaned.ok);
      assertEquals(cleaned.value, false);
    } finally {
      await fx.cleanup();
    }

    const dir = await Deno.makeTempDir({ prefix: "issue-1777-nogit-" });
    try {
      const broken = await hasConflictMarkers([PATH], { cwd: dir });
      assert(!broken.ok, "a check that could not run is not a clean tree");
      assertStringIncludes(
        broken.error.message,
        "conflict-marker check could not be run",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
);

Deno.test(
  "climbConflictLadder - a file the rules settle never reaches the agent",
  async () => {
    const fx = await conflictedClone();
    const calls: MilestoneConflictAgentRequest[] = [];
    try {
      const outcome = await climbConflictLadder({
        escalations: undecided,
        options: { cwd: fx.dir },
        milestoneBranch: "milestone/1777",
        defaultBranch: "main",
        applyRulesFn: () =>
          Promise.resolve({
            resolved: [{
              path: PATH,
              kind: "manifest" as const,
              resolvedBy: "deno.json",
              decisions: [],
              decisionsUnattributed: false,
            }],
            deferred: [],
          }),
        agentFn: (request) => {
          calls.push(request);
          return Promise.resolve({ ok: true, value: { terminated: false } });
        },
      });

      assertEquals(calls.length, 0);
      assertEquals(outcome.escalations, []);
      assertEquals(outcome.resolved.length, 1);
      assertEquals(outcome.resolved[0]?.rung, "rule");
      assertStringIncludes(outcome.resolved[0]!.reason, "deno.json");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "climbConflictLadder - with no agent available the file stays escalated and says so",
  async () => {
    const fx = await conflictedClone();
    try {
      const outcome = await climbConflictLadder({
        escalations: undecided,
        options: { cwd: fx.dir },
        milestoneBranch: "milestone/1777",
        defaultBranch: "main",
        applyRulesFn: rulesDeferEverything,
      });

      assertEquals(outcome.resolved, []);
      assertEquals(outcome.escalations.length, 1);
      assertEquals(outcome.escalations[0]?.action, "escalate");
      assertStringIncludes(
        outcome.escalations[0]!.reason,
        "no resolution agent was available",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "climbConflictLadder - the agent's judgement lines travel with the outcome (Issue #2306)",
  async () => {
    const fx = await conflictedClone();
    try {
      const reply = `Judgement: ${PATH} — kept both designs behind a flag; ` +
        "dropped neither; because each side has a live caller";
      const outcome = await climbConflictLadder({
        escalations: undecided,
        options: { cwd: fx.dir },
        milestoneBranch: "milestone/1777",
        defaultBranch: "main",
        applyRulesFn: rulesDeferEverything,
        agentFn: async (request) => {
          await Deno.writeTextFile(
            `${request.workDir}/${PATH}`,
            "const impl = 'both';\n",
          );
          await git(["add", "--", PATH], request.workDir);
          await Deno.writeTextFile(
            `${request.workDir}/.pr_response_message`,
            `${reply}\n`,
          );
          return { ok: true, value: { terminated: false } };
        },
      });

      assertEquals(outcome.escalations, []);
      assertEquals(outcome.agentReply, reply);
      // The reply file is consumed, so a later run cannot reuse it, and it
      // is not left staged in the merge commit.
      assertEquals(
        await Deno.stat(`${fx.dir}/.pr_response_message`).then(
          () => true,
          () => false,
        ),
        false,
      );
      const staged = await git(["diff", "--cached", "--name-only"], fx.dir);
      assertEquals(staged.includes(".pr_response_message"), false);
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "climbConflictLadder - an agent that wrote no reply reports none (Issue #2306)",
  async () => {
    const fx = await conflictedClone();
    try {
      const outcome = await climbConflictLadder({
        escalations: undecided,
        options: { cwd: fx.dir },
        milestoneBranch: "milestone/1777",
        defaultBranch: "main",
        applyRulesFn: rulesDeferEverything,
        agentFn: async (request) => {
          await Deno.writeTextFile(
            `${request.workDir}/${PATH}`,
            "const impl = 'both';\n",
          );
          await git(["add", "--", PATH], request.workDir);
          return { ok: true, value: { terminated: false } };
        },
      });

      assertEquals(outcome.escalations, []);
      assertEquals(outcome.agentReply, undefined);
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "climbConflictLadder - an agent that touches nothing leaves the path unmerged and is refused",
  async () => {
    const fx = await conflictedClone();
    try {
      const outcome = await climbConflictLadder({
        escalations: undecided,
        options: { cwd: fx.dir },
        milestoneBranch: "milestone/1777",
        defaultBranch: "main",
        applyRulesFn: rulesDeferEverything,
        agentFn: () =>
          Promise.resolve({ ok: true, value: { terminated: false } }),
      });

      assertEquals(outcome.resolved, []);
      assertStringIncludes(
        outcome.escalations[0]!.reason,
        "agent: it left 1 path(s) unmerged",
      );
      // Nothing was staged on its behalf: a do-nothing agent must not have
      // the working-tree side committed as though it had decided.
      const listed = await listUnmergedPaths({ cwd: fx.dir });
      assert(listed.ok);
      assertEquals(listed.value, [PATH]);
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "climbConflictLadder - an agent that stages a tree still full of markers is refused",
  async () => {
    const fx = await conflictedClone();
    try {
      const outcome = await climbConflictLadder({
        escalations: undecided,
        options: { cwd: fx.dir },
        milestoneBranch: "milestone/1777",
        defaultBranch: "main",
        applyRulesFn: rulesDeferEverything,
        agentFn: async (request) => {
          // Stages the conflicted file as git left it — markers and all.
          await git(["add", "--", PATH], request.workDir);
          return { ok: true, value: { terminated: false } };
        },
      });

      assertEquals(outcome.resolved, []);
      assertStringIncludes(
        outcome.escalations[0]!.reason,
        "still contains conflict markers",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "climbConflictLadder - a resolved and staged file is settled, and everything the agent wrote is staged with it",
  async () => {
    const fx = await conflictedClone();
    try {
      const outcome = await climbConflictLadder({
        escalations: undecided,
        options: { cwd: fx.dir },
        milestoneBranch: "milestone/1777",
        defaultBranch: "main",
        applyRulesFn: rulesDeferEverything,
        agentFn: async (request) => {
          await Deno.writeTextFile(
            `${request.workDir}/${PATH}`,
            "const impl = both();\n",
          );
          // A resolution that extracts a helper: the new file is part of it.
          await Deno.writeTextFile(
            `${request.workDir}/lib/both.ts`,
            "export const both = () => 'branch+main';\n",
          );
          await git(["add", "--", PATH], request.workDir);
          return { ok: true, value: { terminated: false } };
        },
      });

      assertEquals(outcome.escalations, []);
      assertEquals(outcome.resolved.length, 1);
      assertEquals(outcome.resolved[0]?.rung, "agent");
      assertEquals(outcome.resolved[0]?.action, "resolved");
      assertStringIncludes(
        await git(["diff", "--cached", "--name-only"], fx.dir),
        "lib/both.ts",
        "a file the agent added outside the conflicted path is staged too",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "climbConflictLadder - a worker state file in the clone does not cost the resolution",
  async () => {
    const fx = await conflictedClone();
    try {
      await Deno.writeTextFile(`${fx.dir}/.heartbeat_owner_repo_1`, "beat\n");

      const outcome = await climbConflictLadder({
        escalations: undecided,
        options: { cwd: fx.dir },
        milestoneBranch: "milestone/1777",
        defaultBranch: "main",
        applyRulesFn: rulesDeferEverything,
        agentFn: async (request) => {
          await Deno.writeTextFile(
            `${request.workDir}/${PATH}`,
            "const impl = both();\n",
          );
          await git(["add", "--", PATH], request.workDir);
          return { ok: true, value: { terminated: false } };
        },
      });

      assertEquals(outcome.escalations, []);
      assertEquals(outcome.resolved[0]?.rung, "agent");
      const staged = await git(["diff", "--cached", "--name-only"], fx.dir);
      assert(
        !staged.includes(".heartbeat_owner_repo_1"),
        "the worker's own state file is unstaged before the safety gate (Issue #1654)",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "climbConflictLadder - an agent run the worker ended is not a verdict on the conflict",
  async () => {
    const fx = await conflictedClone();
    try {
      const outcome = await climbConflictLadder({
        escalations: undecided,
        options: { cwd: fx.dir },
        milestoneBranch: "milestone/1777",
        defaultBranch: "main",
        applyRulesFn: rulesDeferEverything,
        agentFn: () =>
          Promise.resolve({ ok: true, value: { terminated: true } }),
      });

      assertEquals(outcome.resolved, []);
      assertStringIncludes(
        outcome.escalations[0]!.reason,
        "ended by the worker",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "climbConflictLadder - a provider outage is not a verdict on the conflict (Issue #2613)",
  async () => {
    const fx = await conflictedClone();
    try {
      const outcome = await climbConflictLadder({
        escalations: undecided,
        options: { cwd: fx.dir },
        milestoneBranch: "milestone/1777",
        defaultBranch: "main",
        applyRulesFn: rulesDeferEverything,
        agentFn: () =>
          Promise.resolve({
            ok: true,
            value: {
              terminated: false,
              providerUnavailable: "API Error: 402 Insufficient Balance",
            },
          }),
      });

      assertEquals(outcome.resolved, []);
      const reason = outcome.escalations[0]!.reason;
      assertStringIncludes(reason, AGENT_PROVIDER_UNAVAILABLE);
      assertStringIncludes(reason, "402 Insufficient Balance");
      assert(!reason.includes("unmerged"), reason);
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "climbConflictLadder - times its rules and agent rungs into the sync's timer (Issue #2308)",
  async () => {
    const fx = await conflictedClone();
    try {
      // An injected clock: the ladder's rungs are driven by test doubles, so
      // the seconds asserted here are exactly the ticks handed to the timer.
      let ms = 500_000;
      const timer = createConflictStageTimer(() => ms);

      const outcome = await climbConflictLadder({
        escalations: undecided,
        options: { cwd: fx.dir },
        milestoneBranch: "milestone/1777",
        defaultBranch: "main",
        timer,
        applyRulesFn: (options) => {
          ms += 4_000;
          return rulesDeferEverything(options);
        },
        agentFn: async (request: MilestoneConflictAgentRequest) => {
          ms += 212_000;
          // Resolve the file for real, so the ladder's own guards pass.
          await Deno.writeTextFile(
            `${request.workDir}/${PATH}`,
            "const impl = 'both';\n",
          );
          await git(["add", "--", PATH], request.workDir);
          return { ok: true, value: { terminated: false } };
        },
      });

      assertEquals(outcome.escalations, []);
      assertEquals(timer.report(), [
        { stage: "rules", seconds: 4 },
        { stage: "agent", seconds: 212 },
      ]);
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "climbConflictLadder - an agent rung that failed still reports the time it cost (Issue #2308)",
  async () => {
    const fx = await conflictedClone();
    try {
      let ms = 500_000;
      const timer = createConflictStageTimer(() => ms);

      const outcome = await climbConflictLadder({
        escalations: undecided,
        options: { cwd: fx.dir },
        milestoneBranch: "milestone/1777",
        defaultBranch: "main",
        timer,
        applyRulesFn: rulesDeferEverything,
        agentFn: () => {
          ms += 900_000;
          return Promise.resolve({
            ok: false as const,
            error: new Error("the agent never produced a resolution"),
          });
        },
      });

      assertEquals(outcome.escalations.length, 1);
      // The agent rung did stop — a failed run is still a finished stage; the
      // point is that both rungs are accounted for rather than dropped.
      assertEquals(timer.report().map((t) => t.stage), ["rules", "agent"]);
      assertEquals(timer.report().at(-1)?.seconds, 900);
    } finally {
      await fx.cleanup();
    }
  },
);
