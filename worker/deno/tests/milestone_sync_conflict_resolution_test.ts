/**
 * A conflicted milestone sync resolves what it can and escalates only what it
 * cannot (Issue #1559).
 *
 * Real git repositories throughout — a bare remote, a clone, a milestone
 * branch and a default branch that has moved on — because the decisions being
 * pinned here are decisions about a conflicted index, and a stub of one proves
 * nothing about the real thing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import { isConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import type { MergeGateFn } from "../lib/milestone_merge_gate.ts";

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

/** What one side writes to a file, and the commit subject it writes it under. */
interface Side {
  files: Record<string, string>;
  subject: string;
}

/**
 * A remote whose `main` and `milestone/1559` both moved over the same files.
 *
 * @param seedFiles - The content both branches start from
 * @param milestone - What the milestone branch changed
 * @param main - What the default branch changed
 */
async function setup(
  seedFiles: Record<string, string>,
  milestone: Side,
  main: Side,
): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "issue-1559-" });
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

  await gitOk(["checkout", "-b", "milestone/1559"], seed);
  await write(milestone.files);
  await gitOk(["commit", "-m", milestone.subject], seed);
  await gitOk(["push", "origin", "milestone/1559"], seed);

  await gitOk(["checkout", "main"], seed);
  await write(main.files);
  await gitOk(["commit", "-m", main.subject], seed);
  await gitOk(["push", "origin", "main"], seed);

  const clone = `${root}/clone`;
  await gitOk(["clone", remote, clone], root);
  await gitOk(["config", "user.email", "t@example.com"], clone);
  await gitOk(["config", "user.name", "Test"], clone);
  await gitOk(["checkout", "milestone/1559"], clone);

  return {
    clone,
    cleanup: () => Deno.remove(root, { recursive: true }).catch(() => {}),
  };
}

const passingGate: MergeGateFn = () =>
  Promise.resolve({ status: "passed" as const, detail: "checked", output: "" });

// ---------------------------------------------------------------------------
// Case 1 — the same fix landed twice
// ---------------------------------------------------------------------------

Deno.test(
  "syncMilestoneBranchWithDefault - the same fix landed twice resolves without a human, with the reasoning on the merge commit (Issue #1559)",
  async () => {
    const fx = await setup(
      {
        "lib/spawn.ts": "export const impl = 'seed';\n",
        "tests/spawn_test.ts": 'Deno.test("shared case", () => {});\n',
      },
      {
        files: {
          "lib/spawn.ts": "export const impl = 'branch';\n",
          "tests/spawn_test.ts":
            'Deno.test("shared case", () => {});\nDeno.test("branch adds a case", () => {});\n',
        },
        subject: "Fixes #1270: bound the spawn fallback",
      },
      {
        files: {
          "lib/spawn.ts": "export const impl = 'main';\n",
          "tests/spawn_test.ts": 'Deno.test("shared case", () => {});\n',
        },
        subject: "Fixes #1270: bound the spawn fallback (again)",
      },
    );
    try {
      const result = await syncMilestoneBranchWithDefault(
        "milestone/1559",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );

      assert(
        result.ok,
        `expected the duplicate fix to resolve: ${
          !result.ok && result.error.message
        }`,
      );
      assertEquals(
        await Deno.readTextFile(`${fx.clone}/lib/spawn.ts`),
        "export const impl = 'branch';\n",
        "the side whose tests are a superset is the one kept",
      );
      assertStringIncludes(
        await Deno.readTextFile(`${fx.clone}/tests/spawn_test.ts`),
        "branch adds a case",
      );

      const message = await gitOk(
        ["log", "-1", "--format=%B", "milestone/1559"],
        fx.clone,
      );
      assertStringIncludes(message, "duplicate-fix");
      assertStringIncludes(message, "#1270");
      assertStringIncludes(message, "lib/spawn.ts");
      assertEquals(result.value.conflict?.resolution, "auto");
    } finally {
      await fx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// The coverage rule
// ---------------------------------------------------------------------------

Deno.test(
  "syncMilestoneBranchWithDefault - a test file is never resolved by taking one side wholesale (Issue #1559)",
  async () => {
    const fx = await setup(
      { "tests/gate_test.ts": 'Deno.test("shared case", () => {});\n' },
      {
        files: {
          "tests/gate_test.ts":
            'Deno.test("shared case", () => {});\nDeno.test("branch only", () => {});\n',
        },
        subject: "Issue #1557: the branch's cases",
      },
      {
        files: {
          "tests/gate_test.ts":
            'Deno.test("shared case", () => {});\nDeno.test("main only", () => {});\n',
        },
        subject: "Issue #1557: main's cases",
      },
    );
    try {
      const published = (await gitOk(["rev-parse", "milestone/1559"], fx.clone))
        .trim();

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1559",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );

      assert(!result.ok, "taking either side would drop a case");
      assert(isConflictEscalation(result.error));
      const analysis = result.error.analyses[0];
      assertEquals(analysis?.onlyOursTests, ["branch only"]);
      assertEquals(analysis?.onlyTheirsTests, ["main only"]);
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        published,
        "the branch is exactly as it was",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// A resolution that cannot be verified is not a resolution
// ---------------------------------------------------------------------------

Deno.test(
  "syncMilestoneBranchWithDefault - a resolution nothing could verify is refused, not pushed (Issue #1559)",
  async () => {
    const fx = await setup(
      { "lib/spawn.ts": "const a = 1;\n" },
      {
        files: { "lib/spawn.ts": "const a = 1;\nconst branch = true;\n" },
        subject: "Issue #1559: the branch's side",
      },
      {
        files: {
          "lib/spawn.ts":
            "const a = 1;\nconst branch = true;\nconst bounded = true;\n",
        },
        subject: "Issue #1559: main subsumes it",
      },
    );
    try {
      const published = (await gitOk(["rev-parse", "milestone/1559"], fx.clone))
        .trim();

      // No gate injected: the real resolution gate finds no Deno project in
      // this tree, so nothing verified the resolution.
      const result = await syncMilestoneBranchWithDefault(
        "milestone/1559",
        "main",
        { cwd: fx.clone },
      );

      assert(!result.ok, "an unverified resolution must not be pushed");
      assertStringIncludes(result.error.message, "Issue #1559");
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        published,
        "the local merge is reset away",
      );
      assertEquals(
        (await gitOk(["rev-parse", "origin/milestone/1559"], fx.clone)).trim(),
        published,
        "nothing reached the remote",
      );
    } finally {
      await fx.cleanup();
    }
  },
);
