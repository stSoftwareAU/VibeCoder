/**
 * A sync another host landed during the agent rung is adopted, not pushed
 * over (Issue #2030). Real git with a bare remote and two clones: host B's
 * "agent" is a stub that, while resolving, lets host A land the same sync.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import type { MilestoneConflictAgentFn } from "../lib/milestone_conflict_ladder.ts";

async function git(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  })
    .output();
  const decode = new TextDecoder();
  if (out.code !== 0 && !args.includes("merge")) {
    throw new Error(`git ${args.join(" ")}: ${decode.decode(out.stderr)}`);
  }
  return decode.decode(out.stdout);
}

const BRANCH = "milestone/2030";
const PATH = "lib/rival.ts";

Deno.test("syncMilestoneBranchWithDefault - a sync a sibling landed mid-rung is adopted and nothing is pushed (Issue #2030)", async () => {
  const root = await Deno.makeTempDir({ prefix: "issue-2030-adopt-" });
  try {
    const origin = `${root}/origin.git`;
    const seed = `${root}/seed`;
    await git(["init", "-q", "--bare", origin], root);
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

    const clone = async (name: string): Promise<string> => {
      const dir = `${root}/${name}`;
      await git(["clone", "-q", origin, dir], root);
      await git(["config", "user.email", `${name}@example.com`], dir);
      await git(["config", "user.name", name], dir);
      await git(["checkout", "-q", BRANCH], dir);
      return dir;
    };
    const hostA = await clone("host-a");
    const hostB = await clone("host-b");

    // Host B's agent rung: while it "resolves", host A lands the sync.
    let agentRuns = 0;
    const agentFn: MilestoneConflictAgentFn = async (request) => {
      agentRuns++;
      await git(["merge", "main", "--no-edit"], hostA);
      await Deno.writeTextFile(
        `${hostA}/${PATH}`,
        "const impl = 'both (host A)';\n",
      );
      await git(["add", "-A"], hostA);
      await git(
        ["commit", "-q", "-m", "Merge main into milestone (host A)"],
        hostA,
      );
      await git(["push", "-q", "origin", BRANCH], hostA);
      // Host B's own resolution of the same file.
      await Deno.writeTextFile(
        `${request.workDir}/${PATH}`,
        "const impl = 'both (host B)';\n",
      );
      await git(["add", "--", PATH], request.workDir);
      return { ok: true, value: { terminated: false } };
    };
    const green = () =>
      Promise.resolve({
        status: "passed" as const,
        detail: "stub",
        output: "",
      });

    const outcome = await syncMilestoneBranchWithDefault(
      BRANCH,
      "main",
      { cwd: hostB },
      undefined,
      green,
      green,
      agentFn,
    );
    assert(outcome.ok, outcome.ok ? "" : outcome.error.message);
    assertEquals(agentRuns, 1);
    assertStringIncludes(
      outcome.value.message,
      "ALREADY SYNCED by another host",
    );

    // Host B now stands on host A's sync, and origin still has host A's.
    const localTip = (await git(["rev-parse", "HEAD"], hostB)).trim();
    const remoteTip = (await git(["rev-parse", BRANCH], origin)).trim();
    assertEquals(localTip, remoteTip);
    assertEquals(
      await Deno.readTextFile(`${hostB}/${PATH}`),
      "const impl = 'both (host A)';\n",
    );
    const status = (await git(["status", "--porcelain"], hostB)).trim();
    assertEquals(status, "", "no merge left in progress");
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});
