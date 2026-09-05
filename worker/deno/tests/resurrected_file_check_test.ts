/**
 * Tests for the resurrected-file check (Issue #1048).
 *
 * The first test builds the exact shape that happened on `milestone/863`: a
 * file deleted on main, a **squash** sync of main into the milestone branch,
 * the branch modifying the deleted file, then a real merge whose modify/delete
 * conflict is resolved by keeping the file. That is the case the detector
 * exists for, so it is the one that is pinned.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  findResurrectedFiles,
  formatResurrectionReport,
  parseCommitPathLog,
  parseTreePaths,
} from "../lib/resurrected_file_check.ts";

// ---------------------------------------------------------------------------
// Helpers — a real git repository per test
// ---------------------------------------------------------------------------

/** Run git in `cwd`, returning the runner shape the check expects. */
async function git(
  cwd: string,
  args: string[],
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

/** A git runner bound to one repository. */
function gitIn(cwd: string) {
  return (args: string[]) => git(cwd, args);
}

/** Fail loud in the fixture itself — a mis-built repo must not read as a pass. */
async function gitOk(cwd: string, args: string[]): Promise<string> {
  const out = await git(cwd, args);
  if (out.code !== 0) {
    throw new Error(
      `fixture: git ${args.join(" ")} exited ${out.code}: ${out.stderr}`,
    );
  }
  return out.stdout;
}

/** Create an empty repository with `main` checked out and one commit. */
async function newRepo(prefix: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix });
  await gitOk(dir, ["init", "--initial-branch=main"]);
  await gitOk(dir, ["config", "user.email", "test@example.com"]);
  await gitOk(dir, ["config", "user.name", "Test User"]);
  await gitOk(dir, ["config", "commit.gpgsign", "false"]);
  await Deno.writeTextFile(`${dir}/README.md`, "# fixture\n");
  await gitOk(dir, ["add", "README.md"]);
  await gitOk(dir, ["commit", "-m", "Initial commit"]);
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// The case that actually happened
// ---------------------------------------------------------------------------

Deno.test("findResurrectedFiles - names a file a squash sync let the milestone branch revive", async () => {
  const dir = await newRepo("resurrection_squash_");
  try {
    // 1. main carries the subsystem, and the milestone branch forks from it.
    await Deno.mkdir(`${dir}/lib`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/lib/fleet_health.ts`,
      "export const a=1;\n",
    );
    await gitOk(dir, ["add", "lib/fleet_health.ts"]);
    await gitOk(dir, ["commit", "-m", "Add the fleet-health subsystem"]);
    await gitOk(dir, ["branch", "milestone/863"]);

    // 2. main deletes the subsystem.
    await gitOk(dir, ["rm", "lib/fleet_health.ts"]);
    await gitOk(dir, [
      "commit",
      "-m",
      "Merge the fleet-logs milestone to main (mints 1.2.0)",
    ]);
    const deletingSha = (await gitOk(dir, ["rev-parse", "HEAD"])).trim();

    // main moves on, so the squash below carries content the branch lacks.
    await Deno.writeTextFile(`${dir}/CHANGELOG.md`, "1.2.0\n");
    await gitOk(dir, ["add", "CHANGELOG.md"]);
    await gitOk(dir, ["commit", "-m", "Record the release"]);

    // 3. The sync lands as a SQUASH: main's content, none of its ancestry.
    await gitOk(dir, ["checkout", "milestone/863"]);
    await gitOk(dir, ["merge", "--squash", "main"]);
    await gitOk(dir, ["commit", "-m", "Sync main into milestone/863"]);
    assertEquals(
      (await git(dir, ["merge-base", "--is-ancestor", "main", "HEAD"])).code,
      1,
      "the squash must not make main an ancestor — that is the fault",
    );

    // 4. The branch edits the file main had already deleted — nothing on the
    //    branch flagged that it was editing a file that no longer exists.
    await Deno.mkdir(`${dir}/lib`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/lib/fleet_health.ts`,
      "export const a=2;\n",
    );
    await gitOk(dir, ["add", "lib/fleet_health.ts"]);
    await gitOk(dir, ["commit", "-m", "Issue #869: tweak fleet health"]);

    // 5. The next real merge sees modify/delete and is resolved by keeping
    //    the file — the resolution that looks conservative and is wrong.
    const merge = await git(dir, ["merge", "main", "--no-edit"]);
    assertEquals(merge.code, 1, "the merge must conflict, as it did live");
    await gitOk(dir, ["add", "lib/fleet_health.ts"]);
    await gitOk(dir, ["commit", "--no-edit"]);

    const result = await findResurrectedFiles(
      "milestone/863",
      "main",
      gitIn(dir),
    );
    assert(result.ok, "the check must read the repository");
    if (!result.ok) return;
    assertEquals(result.value.resurrected.length, 1);
    assertEquals(result.value.resurrected[0]!.path, "lib/fleet_health.ts");
    assertEquals(result.value.resurrected[0]!.deletedBySha, deletingSha);
    assertStringIncludes(
      result.value.resurrected[0]!.deletedBySubject,
      "fleet-logs milestone",
    );

    const report = formatResurrectionReport(result.value);
    assertStringIncludes(report, "lib/fleet_health.ts");
    assertStringIncludes(report, deletingSha.slice(0, 8));
  } finally {
    await cleanup(dir);
  }
});

Deno.test("findResurrectedFiles - catches the squash window, before any later merge", async () => {
  const dir = await newRepo("resurrection_squash_window_");
  try {
    await Deno.mkdir(`${dir}/lib`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/lib/fleet_health.ts`,
      "export const a=1;\n",
    );
    await gitOk(dir, ["add", "lib/fleet_health.ts"]);
    await gitOk(dir, ["commit", "-m", "Add the fleet-health subsystem"]);
    await gitOk(dir, ["branch", "milestone/863"]);

    await gitOk(dir, ["rm", "lib/fleet_health.ts"]);
    await gitOk(dir, ["commit", "-m", "Remove the fleet-health subsystem"]);
    const deletingSha = (await gitOk(dir, ["rev-parse", "HEAD"])).trim();

    // The squash sync: main's content, none of its ancestry.
    await gitOk(dir, ["checkout", "milestone/863"]);
    await gitOk(dir, ["merge", "--squash", "main"]);
    await gitOk(dir, ["commit", "-m", "Sync main into milestone/863"]);

    // The branch puts the file back — and nothing has merged main since, so
    // the deletion is NOT in the branch's ancestry.
    await Deno.mkdir(`${dir}/lib`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/lib/fleet_health.ts`,
      "export const a=2;\n",
    );
    await gitOk(dir, ["add", "lib/fleet_health.ts"]);
    await gitOk(dir, ["commit", "-m", "Issue #869: tweak fleet health"]);
    assertEquals(
      (await git(dir, ["merge-base", "--is-ancestor", deletingSha, "HEAD"]))
        .code,
      1,
      "the deletion must be outside the ancestry — that is the window",
    );

    const result = await findResurrectedFiles(
      "milestone/863",
      "main",
      gitIn(dir),
    );
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.resurrected.length, 1);
    assertEquals(result.value.resurrected[0]!.path, "lib/fleet_health.ts");
    assertEquals(result.value.resurrected[0]!.deletionIntegrated, false);
    assertStringIncludes(
      formatResurrectionReport(result.value),
      "squash sync",
    );
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// The negative direction — legitimately-new files must never be reported
// ---------------------------------------------------------------------------

Deno.test("findResurrectedFiles - ignores files that are new on the branch and never on main", async () => {
  const dir = await newRepo("resurrection_new_files_");
  try {
    await gitOk(dir, ["checkout", "-b", "milestone/new"]);
    for (const name of ["one.ts", "two.ts", "three.ts"]) {
      await Deno.writeTextFile(`${dir}/${name}`, "export const x=1;\n");
    }
    await gitOk(dir, ["add", "."]);
    await gitOk(dir, ["commit", "-m", "Add three genuinely new files"]);

    const result = await findResurrectedFiles(
      "milestone/new",
      "main",
      gitIn(dir),
    );
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.branchOnlyFiles, 3);
    assertEquals(result.value.resurrected, []);
    assertStringIncludes(
      formatResurrectionReport(result.value),
      "No resurrected",
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("findResurrectedFiles - a branch that is merely behind the deletion is not a resurrection", async () => {
  const dir = await newRepo("resurrection_behind_");
  try {
    await Deno.writeTextFile(`${dir}/doomed.ts`, "export const x=1;\n");
    await gitOk(dir, ["add", "doomed.ts"]);
    await gitOk(dir, ["commit", "-m", "Add doomed.ts"]);
    await gitOk(dir, ["branch", "milestone/stale"]);

    // main deletes it; the branch never merges that history.
    await gitOk(dir, ["rm", "doomed.ts"]);
    await gitOk(dir, ["commit", "-m", "Delete doomed.ts"]);

    const result = await findResurrectedFiles(
      "milestone/stale",
      "main",
      gitIn(dir),
    );
    assert(result.ok);
    if (!result.ok) return;
    assertEquals(result.value.branchOnlyFiles, 1);
    assertEquals(
      result.value.resurrected,
      [],
      "a stale branch has not seen the deletion — merging it loses nothing",
    );
  } finally {
    await cleanup(dir);
  }
});

Deno.test("findResurrectedFiles - a re-delete on the branch clears the report", async () => {
  const dir = await newRepo("resurrection_cleared_");
  try {
    await Deno.writeTextFile(`${dir}/gone.ts`, "export const x=1;\n");
    await gitOk(dir, ["add", "gone.ts"]);
    await gitOk(dir, ["commit", "-m", "Add gone.ts"]);
    await gitOk(dir, ["branch", "milestone/fixed"]);
    await gitOk(dir, ["rm", "gone.ts"]);
    await gitOk(dir, ["commit", "-m", "Delete gone.ts"]);

    // The branch merges main and keeps the file — the resurrection.
    await gitOk(dir, ["checkout", "milestone/fixed"]);
    await Deno.writeTextFile(`${dir}/gone.ts`, "export const x=2;\n");
    await gitOk(dir, ["add", "gone.ts"]);
    await gitOk(dir, ["commit", "-m", "Modify gone.ts"]);
    assertEquals((await git(dir, ["merge", "main", "--no-edit"])).code, 1);
    await gitOk(dir, ["add", "gone.ts"]);
    await gitOk(dir, ["commit", "--no-edit"]);

    const before = await findResurrectedFiles(
      "milestone/fixed",
      "main",
      gitIn(dir),
    );
    assert(before.ok && before.value.resurrected.length === 1);

    // Deleting it on the branch is the fix, and the check must go green.
    await gitOk(dir, ["rm", "gone.ts"]);
    await gitOk(dir, ["commit", "-m", "Re-delete gone.ts (Issue #1048)"]);
    const after = await findResurrectedFiles(
      "milestone/fixed",
      "main",
      gitIn(dir),
    );
    assert(after.ok);
    if (!after.ok) return;
    assertEquals(after.value.resurrected, []);
  } finally {
    await cleanup(dir);
  }
});

// ---------------------------------------------------------------------------
// Error paths — a check that cannot read the repo must never report clean
// ---------------------------------------------------------------------------

Deno.test("findResurrectedFiles - an unknown ref fails loud rather than reporting clean", async () => {
  const dir = await newRepo("resurrection_bad_ref_");
  try {
    const result = await findResurrectedFiles(
      "no-such-branch",
      "main",
      gitIn(dir),
    );
    assertEquals(result.ok, false);
    if (result.ok) return;
    assertStringIncludes(result.error.message, "no-such-branch");
  } finally {
    await cleanup(dir);
  }
});

Deno.test("findResurrectedFiles - refuses an option-shaped ref before running git", async () => {
  let ran = false;
  const result = await findResurrectedFiles(
    "--upload-pack=evil",
    "main",
    () => {
      ran = true;
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  );
  assertEquals(result.ok, false);
  assertEquals(ran, false, "no git may run for an option-shaped ref");
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

Deno.test("parseCommitPathLog - attributes each path to its most recent deletion", () => {
  const log = "\0bbbb\tSecond deletion\n\nlib/two.ts\n" +
    "\0aaaa\tFirst deletion\n\nlib/one.ts\nlib/two.ts\n";
  const parsed = parseCommitPathLog(log);
  assertEquals(parsed.get("lib/two.ts"), {
    sha: "bbbb",
    subject: "Second deletion",
  });
  assertEquals(parsed.get("lib/one.ts"), {
    sha: "aaaa",
    subject: "First deletion",
  });
});

Deno.test("parseTreePaths - splits NUL-delimited ls-tree output", () => {
  assertEquals(parseTreePaths("a.ts\0dir/b.ts\0"), ["a.ts", "dir/b.ts"]);
  assertEquals(parseTreePaths(""), []);
});
