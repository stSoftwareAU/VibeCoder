/**
 * An agent rung that commits the merge itself does not cost the sync its
 * resolution (Issue #1964).
 *
 * The merge-conflict prompt lets the agent stage and commit, and when it did
 * the worker's own final-mile `git commit -m …` found nothing to commit,
 * exited 1 with its explanation on **stdout**, and the sync reported "git
 * reported no stderr", aborted and threw the resolution away — every cycle,
 * until a human took the branch.
 *
 * Real git repositories throughout: the behaviour under test is what git
 * leaves behind after a committed merge, and a stub of that proves nothing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import type { MergeGateFn } from "../lib/milestone_merge_gate.ts";
import type { MilestoneConflictAgentFn } from "../lib/milestone_conflict_ladder.ts";

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

/** The prose both sides reworded — the shape of the conflict that was lost. */
const SEED = "The workspace has 12 crates.\n";
const BRANCH = "The workspace holds 13 crates.\n";
const MAIN = "There are 14 crates in the workspace.\n";

/** A remote whose `main` and `milestone/1964` both changed the same files. */
async function setup(
  seedFiles: Record<string, string> = { "docs/development.md": SEED },
  milestoneFiles: Record<string, string> = { "docs/development.md": BRANCH },
  mainFiles: Record<string, string> = { "docs/development.md": MAIN },
): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "issue-1964-" });
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

  await write(seedFiles);
  await gitOk(["commit", "-m", "Seed"], seed);
  await gitOk(["push", "origin", "main"], seed);

  await gitOk(["checkout", "-b", "milestone/1964"], seed);
  await write(milestoneFiles);
  await gitOk(["commit", "-m", "Issue #1964: the branch reworded it"], seed);
  await gitOk(["push", "origin", "milestone/1964"], seed);

  await gitOk(["checkout", "main"], seed);
  await write(mainFiles);
  await gitOk(["commit", "-m", "Issue #1964: main reworded it"], seed);
  await gitOk(["push", "origin", "main"], seed);

  const clone = `${root}/clone`;
  await gitOk(["clone", remote, clone], root);
  await gitOk(["config", "user.email", "t@example.com"], clone);
  await gitOk(["config", "user.name", "Test"], clone);
  await gitOk(["checkout", "milestone/1964"], clone);

  return {
    clone,
    cleanup: () => Deno.remove(root, { recursive: true }).catch(() => {}),
  };
}

const passingGate: MergeGateFn = () =>
  Promise.resolve({ status: "passed" as const, detail: "checked", output: "" });

const RESOLUTION = "The workspace holds 14 crates.\n";

/** An agent that resolves the prose conflict and does `after` with it. */
function agentThat(
  after: (workDir: string) => Promise<void>,
): MilestoneConflictAgentFn {
  return async (request) => {
    await Deno.writeTextFile(
      `${request.workDir}/docs/development.md`,
      RESOLUTION,
    );
    await after(request.workDir);
    return { ok: true as const, value: { terminated: false } };
  };
}

Deno.test(
  "syncMilestoneBranchWithDefault - an agent that stages AND commits the merge keeps its resolution, which is gated and pushed (Issue #1964)",
  async () => {
    const fx = await setup();
    try {
      const preMergeSha = (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim();
      const defaultSha = (await gitOk(["rev-parse", "main"], fx.clone)).trim();

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1964",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
        undefined,
        agentThat(async (workDir) => {
          await gitOk(["add", "--", "docs/development.md"], workDir);
          await gitOk(["commit", "--no-edit"], workDir);
        }),
      );

      assert(
        result.ok,
        `the agent's own commit must not cost the sync its resolution: ${
          !result.ok && result.error.message
        }`,
      );
      assertEquals(
        await Deno.readTextFile(`${fx.clone}/docs/development.md`),
        RESOLUTION,
        "what the agent wrote is what was kept",
      );
      const head = (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim();
      assertEquals(
        (await gitOk(["rev-parse", "origin/milestone/1964"], fx.clone)).trim(),
        head,
        "the resolution is pushed in the same call",
      );
      assertEquals(
        (await gitOk(["rev-list", "--parents", "-n", "1", "HEAD"], fx.clone))
          .trim().split(/\s+/).slice(1),
        [preMergeSha, defaultSha],
        "exactly one merge commit, of the two sides — not a second writer",
      );
      const message = await gitOk(
        ["log", "-1", "--format=%B", "HEAD"],
        fx.clone,
      );
      assertStringIncludes(
        message,
        "agent",
        "the commit message names the rung that settled the file",
      );
      assertStringIncludes(message, "docs/development.md");
      assertEquals(
        result.value.conflict?.decisions?.[0]?.rung,
        "agent",
        "the outcome names the agent as the rung that settled the file",
      );
      assertStringIncludes(result.value.message, "agent");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - an agent that only stages still has the worker commit the merge (Issue #1964)",
  async () => {
    const fx = await setup();
    try {
      const preMergeSha = (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim();
      const defaultSha = (await gitOk(["rev-parse", "main"], fx.clone)).trim();

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1964",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
        undefined,
        agentThat(async (workDir) => {
          await gitOk(["add", "--", "docs/development.md"], workDir);
        }),
      );

      assert(result.ok, `${!result.ok && result.error.message}`);
      assertEquals(
        (await gitOk(["rev-list", "--parents", "-n", "1", "HEAD"], fx.clone))
          .trim().split(/\s+/).slice(1),
        [preMergeSha, defaultSha],
        "the worker's own final-mile commit wrote the merge",
      );
      assertEquals(
        (await gitOk(["rev-parse", "origin/milestone/1964"], fx.clone)).trim(),
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - an agent that ends the merge without committing it fails by name, with nothing pushed (Issue #1964)",
  async () => {
    const fx = await setup();
    try {
      const preMergeSha = (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim();

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1964",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
        undefined,
        agentThat(async (workDir) => {
          await gitOk(["merge", "--abort"], workDir);
        }),
      );

      assert(!result.ok, "an abandoned merge is not a resolution");
      assertStringIncludes(result.error.message, "no longer in progress");
      assertStringIncludes(result.error.message, "Issue #1964");
      assert(
        !result.error.message.includes("git reported no stderr"),
        `the failure names the state, not a missing stderr: ${result.error.message}`,
      );
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        preMergeSha,
        "the branch stands exactly where it did",
      );
      assertEquals(
        (await gitOk(["rev-parse", "origin/milestone/1964"], fx.clone)).trim(),
        preMergeSha,
        "nothing reached the remote",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - an agent that commits a hidden path with the merge is refused, and the branch goes back (Issue #1964)",
  async () => {
    const fx = await setup();
    try {
      const preMergeSha = (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim();

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1964",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
        undefined,
        agentThat(async (workDir) => {
          // The pre-commit safety gate never saw this: `git add -A` on the
          // ladder's side finds a clean tree once the agent has committed.
          await Deno.writeTextFile(`${workDir}/.env`, "TOKEN=secret\n");
          await gitOk(["add", "-A"], workDir);
          await gitOk(["commit", "--no-edit"], workDir);
        }),
      );

      assert(!result.ok, "a commit carrying .env must never be adopted");
      assertStringIncludes(result.error.message, ".env");
      assertStringIncludes(result.error.message, "safety gate");
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        preMergeSha,
        "the branch stands exactly where it did",
      );
      assertEquals(
        (await gitOk(["rev-parse", "origin/milestone/1964"], fx.clone)).trim(),
        preMergeSha,
        "nothing reached the remote",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - an agent that commits after the triage's sides were staged is adopted, sides included (Issues #1964, #2006)",
  async () => {
    // `notes.md` is a subsumption the triage settles by taking a side;
    // `docs/development.md` is the rival prose the agent is asked about. The
    // triage's side is staged BEFORE the ladder climbs (Issue #2006), so an
    // agent that commits the whole tree commits the plan's tree: main's
    // `notes.md` beside its own resolution. Before #2006 the side was taken
    // after the ladder, the agent's commit had cleared the merge stages it
    // needed, and the sync refused the whole resolution.
    const fx = await setup(
      { "docs/development.md": SEED, "notes.md": "one\n" },
      { "docs/development.md": BRANCH, "notes.md": "one\ntwo\n" },
      { "docs/development.md": MAIN, "notes.md": "one\ntwo\nthree\n" },
    );
    try {
      const preMergeSha = (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim();

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1964",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
        undefined,
        agentThat(async (workDir) => {
          await gitOk(["add", "-A"], workDir);
          await gitOk(["commit", "--no-edit"], workDir);
        }),
      );

      assert(
        result.ok,
        `the agent's commit carries the plan's tree: ${
          result.ok ? "" : result.error.message
        }`,
      );
      const head = (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim();
      assert(head !== preMergeSha, "the merge landed on the branch");
      assertEquals(
        await gitOk(["show", "HEAD:notes.md"], fx.clone),
        "one\ntwo\nthree\n",
        "the triage's side (main's superset) is in the adopted commit",
      );
      assertEquals(
        await gitOk(["show", "HEAD:docs/development.md"], fx.clone),
        RESOLUTION,
        "beside the agent's resolution",
      );
      assertEquals(
        (await gitOk(["rev-list", "--parents", "-n", "1", "HEAD"], fx.clone))
          .trim().split(" ").length,
        3,
        "one merge commit with two parents",
      );
      assertStringIncludes(
        await gitOk(["log", "-1", "--format=%B"], fx.clone),
        "notes.md",
        "the sync's message names the triaged file",
      );
    } finally {
      await fx.cleanup();
    }
  },
);
