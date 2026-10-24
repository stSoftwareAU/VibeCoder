/**
 * The lib-sweep-record command computes sweptAt itself (Issue #4235).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { libSweepRecordCommand } from "../commands/lib_sweep_record.ts";
import { parseLibSweepRecordArgs } from "../commands/lib_sweep_record.ts";

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: ["-c", "user.email=t@e", "-c", "user.name=t", ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) throw new Error(new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout).trim();
}

Deno.test("parseLibSweepRecordArgs refuses a caller-supplied sweptAt", () => {
  const refused = parseLibSweepRecordArgs([
    "--slice",
    "12a",
    "--status",
    "swept",
    "--paths",
    "worker/deno/lib/a.ts",
    "--swept-at",
    "a".repeat(40),
  ]);
  assert(!refused.ok);
  assert(refused.error.includes("sweptAt"), refused.error);
});

Deno.test("lib-sweep-record replaces a branch-commit sweptAt with the merge base (Issue #4235)", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-lib-sweep-record-" });
  const origin = `${root}/origin.git`;
  const clone = `${root}/clone`;
  try {
    await git(root, "init", "-q", "--bare", "-b", "main", origin);
    await git(root, "clone", "-q", origin, clone);
    await Deno.mkdir(`${clone}/docs/audits`, { recursive: true });
    const branchSha = "b".repeat(40);
    await Deno.writeTextFile(
      `${clone}/docs/audits/lib-sweep-coverage.json`,
      JSON.stringify(
        {
          roots: ["worker/deno/lib"],
          parent: 1,
          description: "fixture",
          slices: [{
            issue: 1,
            chunk: "12a",
            title: "fixture",
            ledger: "docs/audits/fixture.md",
            definition: "fixture",
            status: "claimed",
            sweptAt: branchSha,
            paths: ["worker/deno/lib/fixture_1.ts"],
          }],
        },
        null,
        2,
      ) + "\n",
    );
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "ledger");
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await git(clone, "fetch", "-q", "origin");
    await git(clone, "checkout", "-qb", "feat");
    await Deno.writeTextFile(`${clone}/branch.txt`, "b\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "branch only");
    const feature = await git(clone, "rev-parse", "HEAD");
    const mergeBase = await git(clone, "merge-base", "origin/main", "HEAD");
    assert(feature !== mergeBase);
    const result = await libSweepRecordCommand.execute({
      repo: clone,
      slice: "12a",
      status: "swept",
      paths: ["worker/deno/lib/fixture_1.ts"],
    }, {} as never);
    assert(result.success, result.message);
    const onDisk = JSON.parse(
      await Deno.readTextFile(`${clone}/docs/audits/lib-sweep-coverage.json`),
    );
    assertEquals(onDisk.slices[0].sweptAt, mergeBase);
    assertEquals(onDisk.slices[0].status, "swept");
    assert(onDisk.slices[0].sweptAt !== feature);
    assert(onDisk.slices[0].sweptAt !== branchSha);
    await git(
      clone,
      "merge-base",
      "--is-ancestor",
      onDisk.slices[0].sweptAt,
      "origin/main",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
