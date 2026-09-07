/**
 * The milestone sync reports a conflicting merge instead of resolving it in
 * silence (Issue #1558).
 *
 * A `main` → `milestone/*` merge that conflicts is auto-resolved towards the
 * default branch, so it lands as a success and used to leave no trace beyond
 * a log line. Divergence cost grows superlinearly, so the conflict has to be
 * visible on the day it happens — which means the sync must carry, with its
 * outcome, which files collided and where each side stood.
 *
 * Real git repositories throughout — a bare remote, a clone, a milestone
 * branch and a default branch that has moved on.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import type { MergeGateFn } from "../lib/milestone_merge_gate.ts";
import { isConflictEscalation } from "../lib/milestone_conflict_triage.ts";

async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string }> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
}

async function gitOk(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  return r.stdout;
}

interface Fixture {
  clone: string;
  cleanup: () => Promise<void>;
}

/**
 * A remote with `main` and `milestone/1558`, both of which have moved on.
 *
 * @param collide - When true, both branches edit the same line of the same
 *   file, so merging `main` down conflicts.
 */
async function setupFixture(
  collide: boolean,
  options: { subsumes?: boolean } = {},
): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "issue-1558-" });
  const remote = `${root}/remote.git`;
  const seed = `${root}/seed`;
  await Deno.mkdir(remote, { recursive: true });
  await gitOk(["init", "--bare", "--initial-branch=main", "."], remote);
  await gitOk(["clone", remote, seed], root);
  await gitOk(["config", "user.email", "t@example.com"], seed);
  await gitOk(["config", "user.name", "Test"], seed);

  await Deno.writeTextFile(`${seed}/scan.ts`, "export const rules = 1;\n");
  await gitOk(["add", "scan.ts"], seed);
  await gitOk(["commit", "-m", "Seed"], seed);
  await gitOk(["push", "origin", "main"], seed);

  // The milestone branch changes the shared file.
  await gitOk(["checkout", "-b", "milestone/1558"], seed);
  await Deno.writeTextFile(`${seed}/scan.ts`, "export const rules = 2;\n");
  await gitOk(["commit", "-am", "Issue #1378: IndirectSpawnRules"], seed);
  await gitOk(["push", "origin", "milestone/1558"], seed);

  // The default branch moves on — over the same line when `collide`, and
  // keeping every line of the branch's side when `subsumes` (Issue #1559).
  await gitOk(["checkout", "main"], seed);
  if (collide) {
    await Deno.writeTextFile(
      `${seed}/scan.ts`,
      options.subsumes
        ? "export const rules = 2;\nexport const bounded = true;\n"
        : "export const rules = 3;\n",
    );
    await gitOk(["commit", "-am", "Issue #1227: scanContent…"], seed);
  } else {
    await Deno.writeTextFile(`${seed}/other.ts`, "export const o = 1;\n");
    await gitOk(["add", "other.ts"], seed);
    await gitOk(["commit", "-m", "Issue #1227: unrelated"], seed);
  }
  await gitOk(["push", "origin", "main"], seed);

  const clone = `${root}/clone`;
  await gitOk(["clone", remote, clone], root);
  await gitOk(["config", "user.email", "t@example.com"], clone);
  await gitOk(["config", "user.name", "Test"], clone);

  return {
    clone,
    cleanup: () => Deno.remove(root, { recursive: true }).catch(() => {}),
  };
}

const passingGate: MergeGateFn = () =>
  Promise.resolve({ status: "passed" as const, detail: "checked", output: "" });

Deno.test(
  "syncMilestoneBranchWithDefault - two designs for the same problem escalate with both sides prepared (Issues #1558, #1559)",
  async () => {
    // Business-logic change (Issue #1559): this conflict used to land with
    // the default branch's side taken wholesale and a report filed after the
    // fact. `IndirectSpawnRules` and `scanContentForVariableBinarySpawn` are
    // two designs for one problem, so nothing is pushed and the refusal
    // carries the preparation a human would otherwise do by hand.
    const fx = await setupFixture(true);
    try {
      const milestoneSha =
        (await gitOk(["rev-parse", "origin/milestone/1558"], fx.clone)).trim();
      const defaultSha = (await gitOk(["rev-parse", "origin/main"], fx.clone))
        .trim();

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1558",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );

      assert(!result.ok, "a conflict of rival designs must not be resolved");
      assert(
        isConflictEscalation(result.error),
        `expected the prepared escalation, got: ${
          result.ok ? "ok" : result.error.message
        }`,
      );
      assertEquals(result.error.defaultSha, defaultSha);
      assertEquals(result.error.analyses.length, 1);
      const analysis = result.error.analyses[0];
      assertEquals(analysis?.path, "scan.ts");
      assertEquals(analysis?.oursExports, ["rules"]);
      assertEquals(analysis?.theirsExports, ["rules"]);

      // Nothing was pushed and the branch is exactly as it was.
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        milestoneSha,
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a resolvable conflict lands and reports what it decided (Issues #1558, #1559)",
  async () => {
    const fx = await setupFixture(true, { subsumes: true });
    try {
      const milestoneSha =
        (await gitOk(["rev-parse", "origin/milestone/1558"], fx.clone)).trim();
      const defaultSha = (await gitOk(["rev-parse", "origin/main"], fx.clone))
        .trim();

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1558",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );

      assert(
        result.ok,
        `expected the sync to land: ${!result.ok && result.error.message}`,
      );
      const conflict = result.value.conflict;
      assert(conflict, "a resolved conflict is still reported");
      assertEquals(conflict.files, ["scan.ts"]);
      assertEquals(conflict.milestoneSha, milestoneSha);
      assertEquals(conflict.defaultSha, defaultSha);
      assertEquals(conflict.resolution, "auto");
      assertEquals(conflict.decisions?.length, 1);
      assertEquals(conflict.decisions?.[0]?.path, "scan.ts");
      assertEquals(conflict.decisions?.[0]?.side, "theirs");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a clean merge reports no conflict (Issue #1558)",
  async () => {
    const fx = await setupFixture(false);
    try {
      const result = await syncMilestoneBranchWithDefault(
        "milestone/1558",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );

      assert(
        result.ok,
        `expected the sync to land: ${!result.ok && result.error.message}`,
      );
      assertEquals(
        result.value.conflict,
        undefined,
        "a clean merge is pushed without ceremony",
      );
      assert(result.value.message.includes("milestone/1558"));
    } finally {
      await fx.cleanup();
    }
  },
);
