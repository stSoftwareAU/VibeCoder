/**
 * The agent's judgement lines survive the whole milestone sync (Issue #2306).
 *
 * The PR path has a conclusion comment to carry `.pr_response_message`; the
 * branch path has only the sync report, so the reply has to travel from the
 * clone the agent ran in, through the ladder and the sync outcome, to the
 * conflict record the report comment is built from. Each end is unit-tested
 * on its own; this is the wiring between them, over real git.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import type { MilestoneConflictAgentFn } from "../lib/milestone_conflict_ladder.ts";
import { buildConflictEscalationComment } from "../lib/milestone_sync_conflict.ts";

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

const BRANCH = "milestone/2306";
const PATH = "lib/rival.ts";

const JUDGEMENT = `Judgement: ${PATH} — kept both designs behind a flag; ` +
  "dropped neither; because each side still has a live caller";

/** A remote, a clone, and a milestone branch that conflicts with `main`. */
async function conflictedRemote(
  root: string,
): Promise<{ clone: string; origin: string }> {
  const origin = `${root}/origin.git`;
  const seed = `${root}/seed`;
  await git(["init", "-q", "--bare", origin], root);
  await git(["symbolic-ref", "HEAD", "refs/heads/main"], origin);
  await git(["init", "-q", "--initial-branch=main", seed], root);
  await git(["config", "user.email", "t@example.com"], seed);
  await git(["config", "user.name", "Test"], seed);
  await Deno.mkdir(`${seed}/lib`, { recursive: true });
  await Deno.writeTextFile(`${seed}/${PATH}`, "const impl = 'seed';\n");
  await git(["add", "-A"], seed);
  await git(["commit", "-q", "-m", "Seed"], seed);
  await git(["checkout", "-q", "-b", BRANCH], seed);
  await Deno.writeTextFile(`${seed}/${PATH}`, "const impl = 'branch';\n");
  await git(["commit", "-qam", "The branch's design"], seed);
  await git(["checkout", "-q", "main"], seed);
  await Deno.writeTextFile(`${seed}/${PATH}`, "const impl = 'main';\n");
  await git(["commit", "-qam", "Main's rival design"], seed);
  await git(["remote", "add", "origin", origin], seed);
  await git(["push", "-q", "origin", "main", BRANCH], seed);

  const clone = `${root}/clone`;
  await git(["clone", "-q", origin, clone], root);
  await git(["config", "user.email", "c@example.com"], clone);
  await git(["config", "user.name", "Clone"], clone);
  await git(["checkout", "-q", BRANCH], clone);
  return { clone, origin };
}

const green = () =>
  Promise.resolve({ status: "passed" as const, detail: "stub", output: "" });

Deno.test(
  "syncMilestoneBranchWithDefault - the agent's judgement lines reach the sync report (Issue #2306)",
  async () => {
    const root = await Deno.makeTempDir({ prefix: "issue-2306-judgement-" });
    try {
      const { clone } = await conflictedRemote(root);
      const agentFn: MilestoneConflictAgentFn = async (request) => {
        await Deno.writeTextFile(
          `${request.workDir}/${PATH}`,
          "const impl = 'both';\n",
        );
        await git(["add", "--", PATH], request.workDir);
        await Deno.writeTextFile(
          `${request.workDir}/.pr_response_message`,
          `Merged main in.\n${JUDGEMENT}\n`,
        );
        return { ok: true, value: { terminated: false } };
      };

      const outcome = await syncMilestoneBranchWithDefault(
        BRANCH,
        "main",
        { cwd: clone },
        undefined,
        green,
        green,
        agentFn,
      );

      assert(outcome.ok, outcome.ok ? "" : outcome.error.message);
      const conflict = outcome.value.conflict;
      assert(conflict, "a conflicted sync reports its conflict");
      assertStringIncludes(conflict.agentReply ?? "", JUDGEMENT);

      // The report a reader actually sees carries it too.
      const comment = buildConflictEscalationComment({
        repo: "owner/repo",
        milestoneBranch: BRANCH,
        defaultBranch: "main",
        conflict,
        tips: [],
      });
      assertStringIncludes(comment, JUDGEMENT);

      // The reply is worker state, never part of the merge commit.
      assertEquals(
        await Deno.stat(`${clone}/.pr_response_message`).then(
          () => true,
          () => false,
        ),
        false,
        "the reply file is consumed, so no later run reuses it",
      );
      const tracked = await git(
        ["ls-files", "--", ".pr_response_message"],
        clone,
      );
      assertEquals(tracked.trim(), "");
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
);
