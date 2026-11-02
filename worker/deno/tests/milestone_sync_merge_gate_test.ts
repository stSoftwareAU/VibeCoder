/**
 * Tests for the merge gate on the milestone sync push (Issue #974).
 *
 * Real git repositories: a bare remote, a clone, a milestone branch and a
 * default branch that has moved on. The sync merges locally and then must
 * decide whether the merged tree may be published — the decision this issue
 * adds, because three merges that git called clean deleted live wiring and
 * were pushed unchecked.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import { isConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import {
  isMergeGateFailure,
  isMergeGateUnverifiable,
  type MergeGateFn,
} from "../lib/milestone_merge_gate.ts";
import { judgeSyncFailure } from "../lib/milestone_branch_sync.ts";

async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function gitOk(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r.stdout;
}

interface Fixture {
  root: string;
  remote: string;
  clone: string;
  /** SHA of the milestone branch as published, before any sync. */
  milestoneSha: string;
  cleanup: () => Promise<void>;
}

/**
 * A remote with `main` two commits along and `milestone/974` pushed one
 * commit behind it — the state every sync cycle starts from.
 */
async function setupBehindMilestone(): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "issue-974-sync-" });
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

  await gitOk(["checkout", "-b", "milestone/974"], clone);
  await Deno.writeTextFile(`${clone}/milestone.txt`, "milestone work\n");
  await gitOk(["add", "milestone.txt"], clone);
  await gitOk(["commit", "-m", "milestone work"], clone);
  await gitOk(["push", "-u", "origin", "milestone/974"], clone);
  const milestoneSha = (await gitOk(["rev-parse", "HEAD"], clone)).trim();

  // main moves on — this is what the sync will merge in.
  await gitOk(["checkout", "main"], clone);
  await Deno.writeTextFile(`${clone}/main.txt`, "main work\n");
  await gitOk(["add", "main.txt"], clone);
  await gitOk(["commit", "-m", "main work"], clone);
  await gitOk(["push", "origin", "main"], clone);
  await gitOk(["checkout", "milestone/974"], clone);

  return {
    root,
    remote,
    clone,
    milestoneSha,
    cleanup: async () => {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    },
  };
}

/** SHA the bare remote holds for a branch. */
async function remoteSha(fx: Fixture, branch: string): Promise<string> {
  return (await gitOk(["rev-parse", branch], fx.remote)).trim();
}

const failingGate: MergeGateFn = () =>
  Promise.resolve({
    status: "failed" as const,
    detail: "deno task check in /clone/worker/deno failed (exit 1)",
    output: "TS2339 [ERROR]: Property 'onSlotIdle' does not exist on type",
  });

/** A gate whose check never saw the tree (Issue #4697). */
const unverifiableGate: MergeGateFn = () =>
  Promise.resolve({
    status: "failed" as const,
    detail: "cargo check in /clone could not be checked",
    output: "the 'agent' account cannot read '/clone'",
    unverifiable: true,
  });

const passingGate: MergeGateFn = () =>
  Promise.resolve({ status: "passed" as const, detail: "checked", output: "" });

Deno.test(
  "syncMilestoneBranchWithDefault - a merged tree that fails the type check is not pushed (Issue #974)",
  async () => {
    const fx = await setupBehindMilestone();
    try {
      const result = await syncMilestoneBranchWithDefault(
        "milestone/974",
        "main",
        { cwd: fx.clone },
        undefined,
        failingGate,
      );

      assert(!result.ok, "the sync must refuse a tree that does not compile");
      assert(
        isMergeGateFailure(result.error),
        `expected the typed gate refusal, got: ${result.error.message}`,
      );
      assertStringIncludes(result.error.message, "onSlotIdle");
      assertStringIncludes(result.error.message, "milestone/974");

      assertEquals(
        await remoteSha(fx, "milestone/974"),
        fx.milestoneSha,
        "the published milestone branch is untouched",
      );
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        fx.milestoneSha,
        "the local merge commit is reset away, not left on the branch",
      );
      const status = await gitOk(["status", "--porcelain"], fx.clone);
      assertEquals(status.trim(), "", "no half-merged tree is left behind");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a merged tree that passes is pushed as before (Issue #974)",
  async () => {
    const fx = await setupBehindMilestone();
    try {
      const result = await syncMilestoneBranchWithDefault(
        "milestone/974",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );

      assert(
        result.ok,
        `expected a successful sync: ${!result.ok && result.error.message}`,
      );
      const pushed = await remoteSha(fx, "milestone/974");
      assert(
        pushed !== fx.milestoneSha,
        "the merge reached the published milestone branch",
      );
      // main's commit is now an ancestor of the published milestone branch.
      const contains = await git(
        ["merge-base", "--is-ancestor", "main", "milestone/974"],
        fx.remote,
      );
      assertEquals(contains.code, 0, "main is merged into the pushed branch");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a repo with no type check says so rather than claiming a gated sync (Issue #974)",
  async () => {
    const fx = await setupBehindMilestone();
    try {
      // No gate injected: the real gate finds no Deno project in this tree.
      const result = await syncMilestoneBranchWithDefault(
        "milestone/974",
        "main",
        { cwd: fx.clone },
      );

      assert(
        result.ok,
        `expected a successful sync: ${!result.ok && result.error.message}`,
      );
      assertStringIncludes(result.value.message, "UNGATED");
      assert(
        (await remoteSha(fx, "milestone/974")) !== fx.milestoneSha,
        "an unchecked repo still syncs — it simply says the tree was not checked",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - the gate also guards a conflict-resolved merge (Issue #974)",
  async () => {
    const fx = await setupBehindMilestone();
    try {
      // Both branches edit the same file, and `main`'s side keeps every line
      // of the milestone side — a conflict the triage resolves on its own
      // (Issue #1559). The gate must guard that resolution too, since a
      // resolution that keeps one side is exactly how the wiring was lost.
      await gitOk(["checkout", "main"], fx.clone);
      await Deno.writeTextFile(
        `${fx.clone}/shared.txt`,
        "shared line\nmain adds a line\n",
      );
      await gitOk(["add", "shared.txt"], fx.clone);
      await gitOk(["commit", "-m", "main edits shared"], fx.clone);
      await gitOk(["push", "origin", "main"], fx.clone);
      await gitOk(["checkout", "milestone/974"], fx.clone);
      await Deno.writeTextFile(`${fx.clone}/shared.txt`, "shared line\n");
      await gitOk(["add", "shared.txt"], fx.clone);
      await gitOk(["commit", "-m", "milestone edits shared"], fx.clone);
      await gitOk(["push", "origin", "milestone/974"], fx.clone);
      const published = await remoteSha(fx, "milestone/974");

      const result = await syncMilestoneBranchWithDefault(
        "milestone/974",
        "main",
        { cwd: fx.clone },
        undefined,
        failingGate,
      );

      assert(!result.ok, "a conflict-resolved merge is gated too");
      // Issue #1559: the refusal now carries both halves — what the gate
      // said, and the two sides that produced it — rather than the raw
      // compiler output alone.
      assert(
        isConflictEscalation(result.error),
        `expected the prepared refusal, got: ${result.error.message}`,
      );
      assertStringIncludes(
        result.error.gateFailure ?? "",
        "does not pass the repository's own check",
      );
      assertEquals(
        await remoteSha(fx, "milestone/974"),
        published,
        "the published milestone branch is untouched",
      );
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        published,
        "the local resolution is reset away",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a tree the gate could not see is refused as unverifiable, and is not charged (Issue #4697)",
  async () => {
    const fx = await setupBehindMilestone();
    try {
      const result = await syncMilestoneBranchWithDefault(
        "milestone/974",
        "main",
        { cwd: fx.clone },
        undefined,
        unverifiableGate,
      );

      assert(!result.ok, "a tree nothing checked must not be pushed");
      assert(isMergeGateUnverifiable(result.error), result.error.message);
      assert(
        !isMergeGateFailure(result.error),
        "an environment fault is not a tree the check refused",
      );
      assertEquals(
        await remoteSha(fx, "milestone/974"),
        fx.milestoneSha,
        "nothing was pushed",
      );
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        fx.milestoneSha,
        "the local merge is reset away",
      );
      // The verdict the sync records: not charged, no refusal counted, so the
      // recovery ladder never climbs on it.
      const conclusion = judgeSyncFailure(result.error, true);
      assertEquals(conclusion.outcome, "not-charged");
      assertEquals(conclusion.refusal, undefined);

      // Control: the same fixture refused by a real failing check is charged.
      const refused = await syncMilestoneBranchWithDefault(
        "milestone/974",
        "main",
        { cwd: fx.clone },
        undefined,
        failingGate,
      );
      assert(!refused.ok);
      assertEquals(judgeSyncFailure(refused.error, true).outcome, "failed");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a resolution the gate could not see is refused without a refusal count or a repair (Issue #4697)",
  async () => {
    const fx = await setupBehindMilestone();
    try {
      await gitOk(["checkout", "main"], fx.clone);
      await Deno.writeTextFile(
        `${fx.clone}/shared.txt`,
        "shared line\nmain adds a line\n",
      );
      await gitOk(["add", "shared.txt"], fx.clone);
      await gitOk(["commit", "-m", "main edits shared"], fx.clone);
      await gitOk(["push", "origin", "main"], fx.clone);
      await gitOk(["checkout", "milestone/974"], fx.clone);
      await Deno.writeTextFile(`${fx.clone}/shared.txt`, "shared line\n");
      await gitOk(["add", "shared.txt"], fx.clone);
      await gitOk(["commit", "-m", "milestone edits shared"], fx.clone);
      await gitOk(["push", "origin", "milestone/974"], fx.clone);
      const published = await remoteSha(fx, "milestone/974");

      let agentCalls = 0;
      const result = await syncMilestoneBranchWithDefault(
        "milestone/974",
        "main",
        { cwd: fx.clone },
        undefined,
        unverifiableGate,
        unverifiableGate,
        () => {
          agentCalls++;
          return Promise.resolve({
            ok: false,
            error: new Error("no repair available in this fixture"),
          });
        },
      );

      assert(!result.ok);
      assert(isConflictEscalation(result.error), result.error.message);
      assertEquals(result.error.unverifiable, true);
      assertEquals(agentCalls, 0, "no repair round for an environment fault");
      const conclusion = judgeSyncFailure(result.error, true);
      assertEquals(conclusion.outcome, "not-charged");
      assertEquals(
        conclusion.refusal,
        undefined,
        "not counted toward the refusal ceiling",
      );
      assertEquals(await remoteSha(fx, "milestone/974"), published);

      // Control: a real refusal of the same resolution is a counted refusal.
      const refused = await syncMilestoneBranchWithDefault(
        "milestone/974",
        "main",
        { cwd: fx.clone },
        undefined,
        failingGate,
        failingGate,
      );
      assert(!refused.ok);
      assertEquals(judgeSyncFailure(refused.error, true).refusal, true);
    } finally {
      await fx.cleanup();
    }
  },
);
