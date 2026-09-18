/**
 * A failed verification goes back to the agent rung, not to a human
 * (Issue #1965).
 *
 * The shape from `GRQ-AutoTrader#292`: the default branch adds a method to a
 * trait, the milestone branch carries an implementor no hunk touches, git
 * merges every file cleanly, and the type check then fails in a file git never
 * reported as conflicted. The repair is four lines the resolution agent writes
 * every day, so the sync offers the failure back to it — bounded, on the same
 * clone, with the gate's own output — and only a tree the gate still refuses
 * reaches a human.
 *
 * Real git repositories throughout, and a gate that really reads the merged
 * tree: the behaviour under test is what git and a semantic check leave
 * behind, and a stubbed verdict proves neither.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import type { MergeGateFn } from "../lib/milestone_merge_gate.ts";
import type {
  MilestoneConflictAgentFn,
  MilestoneConflictAgentRequest,
} from "../lib/milestone_conflict_ladder.ts";
import { gateRepairBudgetExhausted } from "../lib/milestone_gate_repair.ts";

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
  const decode = new TextDecoder();
  return {
    code: out.code,
    stdout: decode.decode(out.stdout),
    stderr: decode.decode(out.stderr),
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
  clone: string;
  cleanup: () => Promise<void>;
}

/** The trait, before either side touched it. */
const TRAIT_SEED = `pub trait Broker {
    fn submit(&self, order: Order) -> Result<OrderId>;
}
`;

/** The default branch added a method to the trait (the #284 change). */
const TRAIT_MAIN = `pub trait Broker {
    fn submit(&self, order: Order) -> Result<OrderId>;
    fn find_by_client_order_id(&self, id: &str) -> Result<Option<Order>>;
}
`;

/** The milestone branch's own fake, which no hunk of the merge touches. */
const FAKE_BRANCH = `struct StopEngagingSession {
    inner: FakeBroker,
}

impl Broker for StopEngagingSession {
    fn submit(&self, order: Order) -> Result<OrderId> {
        self.inner.submit(order)
    }
}
`;

/** The four lines the repair adds, delegating to the sibling fake. */
const FAKE_REPAIRED = `struct StopEngagingSession {
    inner: FakeBroker,
}

impl Broker for StopEngagingSession {
    fn submit(&self, order: Order) -> Result<OrderId> {
        self.inner.submit(order)
    }

    fn find_by_client_order_id(&self, id: &str) -> Result<Option<Order>> {
        self.inner.find_by_client_order_id(id)
    }
}
`;

/** Prose both sides reworded — the one conflict git actually reports. */
const DOCS_SEED = "The workspace has 12 crates.\n";
const DOCS_BRANCH = "The workspace holds 13 crates.\n";
const DOCS_MAIN = "There are 14 crates in the workspace.\n";
const DOCS_RESOLVED = "The workspace holds 14 crates.\n";

/**
 * A remote whose default branch adds a trait method the milestone branch's
 * own test fake does not implement, and whose only textual conflict is prose.
 */
async function setup(): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "issue-1965-" });
  const remote = `${root}/remote.git`;
  const seed = `${root}/seed`;
  await Deno.mkdir(remote, { recursive: true });
  await gitOk(["init", "--bare", "--initial-branch=main", "."], remote);
  await gitOk(["clone", remote, seed], root);
  await gitOk(["config", "user.email", "t@example.com"], seed);
  await gitOk(["config", "user.name", "Test"], seed);

  const write = async (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      const dir = path.includes("/")
        ? `${seed}/${path.slice(0, path.lastIndexOf("/"))}`
        : seed;
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(`${seed}/${path}`, content);
    }
    await gitOk(["add", "-A"], seed);
  };

  await write({
    "docs/development.md": DOCS_SEED,
    "crates/control/src/broker.rs": TRAIT_SEED,
  });
  await gitOk(["commit", "-m", "Seed"], seed);
  await gitOk(["push", "origin", "main"], seed);

  await gitOk(["checkout", "-b", "milestone/1965"], seed);
  await write({
    "docs/development.md": DOCS_BRANCH,
    "crates/control/tests/runtime.rs": FAKE_BRANCH,
  });
  await gitOk(["commit", "-m", "Issue #1965: the branch added a fake"], seed);
  await gitOk(["push", "origin", "milestone/1965"], seed);

  await gitOk(["checkout", "main"], seed);
  await write({
    "docs/development.md": DOCS_MAIN,
    "crates/control/src/broker.rs": TRAIT_MAIN,
  });
  await gitOk(
    ["commit", "-m", "Issue #284: add find_by_client_order_id to Broker"],
    seed,
  );
  await gitOk(["push", "origin", "main"], seed);

  const clone = `${root}/clone`;
  await gitOk(["clone", remote, clone], root);
  await gitOk(["config", "user.email", "t@example.com"], clone);
  await gitOk(["config", "user.name", "Test"], clone);
  await gitOk(["checkout", "milestone/1965"], clone);

  return {
    clone,
    cleanup: () =>
      Deno.remove(root, { recursive: true }).catch((err) =>
        // A temp tree that outlives the run is worth saying out loud.
        console.error(`could not remove ${root}: ${err}`)
      ),
  };
}

/**
 * The semantic gate: every trait method must be implemented by every
 * implementor in the merged tree.
 *
 * It reads the tree rather than returning a canned verdict, so the fixture's
 * failure is the real one — a file git never reported as conflicted.
 */
const traitGate: MergeGateFn = async (repoDir) => {
  const trait = await Deno.readTextFile(
    `${repoDir}/crates/control/src/broker.rs`,
  );
  const impl = await Deno.readTextFile(
    `${repoDir}/crates/control/tests/runtime.rs`,
  );
  const methods = [...trait.matchAll(/fn (\w+)\(/g)].map((m) => m[1]!);
  const missing = methods.filter((name) => !impl.includes(`fn ${name}(`));
  if (missing.length === 0) {
    return {
      status: "passed",
      detail: "cargo check --workspace --all-targets passed",
      output: "",
    };
  }
  return {
    status: "failed",
    detail: "cargo check --workspace --all-targets failed (exit 101)",
    output: `error[E0046]: not all trait items implemented, missing: \`${
      missing.join("`, `")
    }\`\n   --> crates/control/tests/runtime.rs:1:1`,
  };
};

/** Every request the injected rung was handed, in order. */
type Calls = MilestoneConflictAgentRequest[];

/**
 * A rung that resolves the prose conflict, then repairs whatever the gate
 * names with `repairWith` — or leaves the tree alone when that is null.
 */
function rung(
  calls: Calls,
  repairWith: string | null,
  options: { commitRepair?: boolean } = {},
): MilestoneConflictAgentFn {
  return async (request) => {
    calls.push(request);
    if (!request.repair) {
      await Deno.writeTextFile(
        `${request.workDir}/docs/development.md`,
        DOCS_RESOLVED,
      );
      await gitOk(["add", "--", "docs/development.md"], request.workDir);
      return { ok: true as const, value: { terminated: false } };
    }
    if (repairWith === null) return { ok: true, value: { terminated: false } };
    await Deno.writeTextFile(
      `${request.workDir}/crates/control/tests/runtime.rs`,
      repairWith,
    );
    if (options.commitRepair) {
      await gitOk(["add", "-A"], request.workDir);
      await gitOk(["commit", "-m", "Repair the fake"], request.workDir);
    }
    return { ok: true, value: { terminated: false } };
  };
}

Deno.test(
  "syncMilestoneBranchWithDefault - a gate failure in a file git never conflicted is repaired by the agent rung and pushed (Issue #1965)",
  async () => {
    const fx = await setup();
    try {
      const preMergeSha = (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim();
      const calls: Calls = [];

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1965",
        "main",
        { cwd: fx.clone },
        undefined,
        traitGate,
        undefined,
        rung(calls, FAKE_REPAIRED),
      );

      assert(
        result.ok,
        `the repair must carry the sync through: ${
          !result.ok && result.error.message
        }`,
      );
      assertEquals(calls.length, 2, "one resolution run, then one repair run");
      assertEquals(calls[0]?.repair, undefined, "the first run is no repair");
      assertEquals(calls[1]?.repair?.round, 1, "the second run is round 1");
      assertStringIncludes(
        calls[1]?.repair?.output ?? "",
        "not all trait items implemented",
        "the repair run carries the gate's own output",
      );
      assertStringIncludes(
        calls[1]?.repair?.failingCommand ?? "",
        "cargo check",
        "the repair run carries the failing command",
      );
      assertEquals(
        calls[1]?.repair?.mergedCommitSubjects,
        ["Issue #284: add find_by_client_order_id to Broker"],
        "the repair run carries the merged-in commits' subjects",
      );

      assertEquals(
        (await gitOk(["rev-parse", "origin/milestone/1965"], fx.clone)).trim(),
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        "the repaired tree is pushed",
      );
      const parents = (await gitOk(
        ["rev-list", "--parents", "-n", "1", "HEAD"],
        fx.clone,
      )).trim().split(/\s+/).slice(1);
      assertEquals(parents.length, 2, "one merge commit, not a commit on top");
      assertEquals(parents[0], preMergeSha);
      assertStringIncludes(
        await gitOk(["log", "-1", "--format=%B", "HEAD"], fx.clone),
        "crates/control/tests/runtime.rs",
        "the merge commit names the repaired file",
      );
      assertStringIncludes(
        await gitOk(["log", "-1", "--format=%B", "HEAD"], fx.clone),
        "resolution agent",
        "the merge commit names the rung that repaired it",
      );
      assertEquals(
        await Deno.readTextFile(
          `${fx.clone}/crates/control/tests/runtime.rs`,
        ),
        FAKE_REPAIRED,
        "the repair is what was committed",
      );
      assertEquals(
        result.value.conflict?.repair?.rounds[0]?.files,
        ["crates/control/tests/runtime.rs"],
        "the sync's report names what the repair touched",
      );
      assertStringIncludes(result.value.message, "Issue #1965");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a repair the agent commits itself is folded into the merge commit (Issue #1965)",
  async () => {
    const fx = await setup();
    try {
      const preMergeSha = (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim();
      const calls: Calls = [];

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1965",
        "main",
        { cwd: fx.clone },
        undefined,
        traitGate,
        undefined,
        rung(calls, FAKE_REPAIRED, { commitRepair: true }),
      );

      assert(result.ok, `${!result.ok && result.error.message}`);
      const parents = (await gitOk(
        ["rev-list", "--parents", "-n", "1", "HEAD"],
        fx.clone,
      )).trim().split(/\s+/).slice(1);
      assertEquals(
        parents.length,
        2,
        "the repair's own commit was folded in, not stacked on the merge",
      );
      assertEquals(parents[0], preMergeSha);
      assertEquals(
        await Deno.readTextFile(`${fx.clone}/crates/control/tests/runtime.rs`),
        FAKE_REPAIRED,
      );
      assertEquals(
        (await gitOk(["status", "--porcelain"], fx.clone)).trim(),
        "",
        "nothing is left uncommitted",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a repair the gate still refuses escalates once, with both gate outputs (Issue #1965)",
  async () => {
    const fx = await setup();
    try {
      const preMergeSha = (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim();
      const calls: Calls = [];
      // A repair that changes the file without adding the missing method:
      // the gate refuses it again, exactly as the first tree.
      const NO_HELP = FAKE_BRANCH.replace("inner: FakeBroker,", "inner: Fake,");

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1965",
        "main",
        { cwd: fx.clone },
        undefined,
        traitGate,
        undefined,
        rung(calls, NO_HELP),
      );

      assert(!result.ok, "a tree the gate still refuses is not pushed");
      assertEquals(
        calls.filter((c) => c.repair).length,
        2,
        "the repair is bounded at two rounds and never asked a third time",
      );
      assertStringIncludes(
        result.error.message,
        "not all trait items implemented",
        "the escalation carries the gate output",
      );
      assertStringIncludes(
        result.error.message,
        "The verification that refused the first resolution",
        "the escalation carries the first gate output as well as the last",
      );
      assertStringIncludes(result.error.message, "Issue #1965");
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        preMergeSha,
        "the branch is left exactly where it stood",
      );
      assertEquals(
        (await gitOk(["rev-parse", "origin/milestone/1965"], fx.clone)).trim(),
        preMergeSha,
        "nothing was pushed",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a repair the grant cannot cover escalates saying it was not attempted (Issue #1965)",
  async () => {
    const fx = await setup();
    try {
      const calls: Calls = [];
      const resolveThenRefuse: MilestoneConflictAgentFn = async (request) => {
        calls.push(request);
        if (request.repair) {
          return {
            ok: false,
            error: gateRepairBudgetExhausted(
              "the cycle's agent grant of 600s has 30s left",
            ),
          };
        }
        await Deno.writeTextFile(
          `${request.workDir}/docs/development.md`,
          DOCS_RESOLVED,
        );
        await gitOk(["add", "--", "docs/development.md"], request.workDir);
        return { ok: true, value: { terminated: false } };
      };

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1965",
        "main",
        { cwd: fx.clone },
        undefined,
        traitGate,
        undefined,
        resolveThenRefuse,
      );

      assert(!result.ok, "an unrepaired tree is not pushed");
      assertStringIncludes(
        result.error.message,
        "not attempted for want of budget",
        "the escalation says the repair was never run, and why",
      );
      assertStringIncludes(
        result.error.message,
        "not all trait items implemented",
        "the gate output travels with it",
      );
      assertEquals(
        calls.filter((c) => c.repair).length,
        1,
        "the rung was asked once and refused; it is not asked again",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a repository with no verification to run buys no repair run (Issues #1559, #1965)",
  async () => {
    const fx = await setup();
    try {
      const preMergeSha = (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim();
      const calls: Calls = [];
      const skippingGate: MergeGateFn = () =>
        Promise.resolve({
          status: "skipped" as const,
          detail: "no test:unit task under the merged tree",
          output: "",
        });

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1965",
        "main",
        { cwd: fx.clone },
        undefined,
        skippingGate,
        undefined,
        rung(calls, FAKE_REPAIRED),
      );

      assert(!result.ok, "a resolution nothing verified is not pushed");
      assertEquals(
        calls.filter((c) => c.repair).length,
        0,
        "no agent time is spent asking for a fix to a check that never ran",
      );
      assertStringIncludes(result.error.message, "Issue #1559");
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        preMergeSha,
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a sync with no agent rung still escalates a gate failure, unchanged (Issue #1965)",
  async () => {
    const fx = await setup();
    try {
      // Only the prose conflicts, and the triage settles nothing here, so the
      // ladder needs no agent: the trait failure is the gate's alone.
      const preMergeSha = (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim();
      const result = await syncMilestoneBranchWithDefault(
        "milestone/1965",
        "main",
        { cwd: fx.clone },
        undefined,
        traitGate,
      );

      assert(!result.ok, "nothing settles the conflict without a rung");
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        preMergeSha,
        "the branch is left where it stood",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a repair round's minutes are counted as `agent`, not as `gate` (Issue #2308)",
  async () => {
    // A repair run is usually the largest single block of a sync, and it
    // happens *inside* the verification. Counting it as `gate` would put the
    // sync's biggest cost against the wrong stage — the one thing the
    // timings line exists to get right.
    const fx = await setup();
    try {
      const calls: Calls = [];
      const result = await syncMilestoneBranchWithDefault(
        "milestone/1965",
        "main",
        { cwd: fx.clone },
        undefined,
        traitGate,
        undefined,
        rung(calls, FAKE_REPAIRED),
      );

      assert(result.ok, `${!result.ok && result.error.message}`);
      assertEquals(calls.length, 2, "one resolution run, then one repair run");

      const timings = result.value.conflict?.timings ?? "";
      assertStringIncludes(timings, "Timings (host ");
      // The stages, in the order the sync ran them. The repair agent runs
      // between two slices of the gate, and those slices accumulate into the
      // single `gate` entry rather than opening a second one.
      const stages = timings.slice(timings.indexOf("):") + 2).trim()
        .split(" · ").map((part) => part.split(" ")[0]);
      assertEquals(stages, ["deepen", "rules", "agent", "gate", "push"]);
      // And no stage was abandoned on the way: wrapping the repair agent must
      // not leave the gate looking like it never finished.
      assertEquals(
        timings.includes("unfinished"),
        false,
        `every stage of a repaired sync must be measured; got: ${timings}`,
      );
    } finally {
      await fx.cleanup();
    }
  },
);
