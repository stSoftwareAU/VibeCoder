/**
 * Tests for `.github/scripts/next-release-tag.sh` (Issue #627).
 *
 * The script is the version-selection and increment logic behind
 * `.github/workflows/release-tag.yml`: given every tag in the repository
 * and the tags already on the merge commit, it decides whether to tag and
 * which tag to mint. Post-merge is the only place the real trigger exists,
 * so these tests run the real script against tag lists rather than waiting
 * on a merge to find out.
 *
 * Each test executes the script and asserts on its stdout and exit code —
 * no source-text inspection.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH =
  new URL("../../../.github/scripts/next-release-tag.sh", import.meta.url)
    .pathname;

interface PlanRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the script over the two tag lists, in a throwaway directory. */
async function plan(
  allTags: string[],
  headTags: string[],
): Promise<PlanRun> {
  const dir = await Deno.makeTempDir({ prefix: "next_release_tag_" });
  try {
    const allFile = `${dir}/all-tags.txt`;
    const headFile = `${dir}/head-tags.txt`;
    await Deno.writeTextFile(allFile, allTags.map((t) => `${t}\n`).join(""));
    await Deno.writeTextFile(headFile, headTags.map((t) => `${t}\n`).join(""));
    const out = await new Deno.Command("bash", {
      args: [SCRIPT_PATH, allFile, headFile],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** The `key=value` lines the script prints, parsed as a map. */
function outputs(run: PlanRun): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of run.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const eq = line.indexOf("=");
    assert(eq > 0, `not a key=value line: ${line}`);
    parsed[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return parsed;
}

Deno.test("next-release-tag - a repository with no tags mints 1.0.0", async () => {
  const run = await plan([], []);
  assertEquals(run.code, 0);
  assertEquals(outputs(run), { should_tag: "true", tag: "1.0.0" });
});

Deno.test("next-release-tag - the merge after 1.0.0 produces 1.0.1", async () => {
  const run = await plan(["1.0.0"], []);
  assertEquals(outputs(run), { should_tag: "true", tag: "1.0.1" });
});

Deno.test("next-release-tag - the merge after 1.0.1 produces 1.0.2", async () => {
  const run = await plan(["1.0.0", "1.0.1"], []);
  assertEquals(outputs(run), { should_tag: "true", tag: "1.0.2" });
});

Deno.test("next-release-tag - a hand-minted 1.1.0 moves the series to 1.1.1", async () => {
  const run = await plan(["1.0.0", "1.0.1", "1.1.0"], []);
  assertEquals(outputs(run), { should_tag: "true", tag: "1.1.1" });
});

Deno.test("next-release-tag - a hand-minted 2.0.0 moves the series to 2.0.1", async () => {
  const run = await plan(["1.9.4", "2.0.0"], []);
  assertEquals(outputs(run), { should_tag: "true", tag: "2.0.1" });
});

Deno.test("next-release-tag - segments compare numerically, not lexically", async () => {
  const run = await plan(["1.0.9", "1.0.10", "1.0.2"], []);
  assertEquals(outputs(run), { should_tag: "true", tag: "1.0.11" });
  const wide = await plan(["1.9.0", "1.10.0"], []);
  assertEquals(outputs(wide), { should_tag: "true", tag: "1.10.1" });
});

Deno.test("next-release-tag - tag order in the list does not change the result", async () => {
  const run = await plan(["1.2.0", "0.9.9", "1.1.7"], []);
  assertEquals(outputs(run), { should_tag: "true", tag: "1.2.1" });
});

Deno.test("next-release-tag - a v-prefixed tag counts, and the mint stays bare", async () => {
  const run = await plan(["v1.4.0"], []);
  assertEquals(outputs(run), { should_tag: "true", tag: "1.4.1" });
});

Deno.test("next-release-tag - pre-releases and moving names are not part of the series", async () => {
  const run = await plan(
    ["1.0.0", "1.1.0-rc1", "2.0.0+build.7", "latest", "v9", "1.0"],
    [],
  );
  assertEquals(outputs(run), { should_tag: "true", tag: "1.0.1" });
});

Deno.test("next-release-tag - a commit that already carries a release tag is not tagged again", async () => {
  const run = await plan(["1.0.0", "1.0.1"], ["1.0.1"]);
  assertEquals(run.code, 0);
  assertEquals(outputs(run), { should_tag: "false", tag: "" });
  assertStringIncludes(run.stderr, "already tagged");
});

Deno.test("next-release-tag - a commit carrying only a non-release tag is still tagged", async () => {
  const run = await plan(["1.0.0", "nightly"], ["nightly"]);
  assertEquals(outputs(run), { should_tag: "true", tag: "1.0.1" });
});

Deno.test("next-release-tag - padded segments do not abort the arithmetic", async () => {
  const run = await plan(["1.08.09"], []);
  assertEquals(run.code, 0);
  assertEquals(outputs(run), { should_tag: "true", tag: "1.8.10" });
});

Deno.test("next-release-tag - a missing input file fails loud, it is not an empty tag list", async () => {
  const dir = await Deno.makeTempDir({ prefix: "next_release_tag_missing_" });
  try {
    const headFile = `${dir}/head-tags.txt`;
    await Deno.writeTextFile(headFile, "");
    const out = await new Deno.Command("bash", {
      args: [SCRIPT_PATH, `${dir}/absent.txt`, headFile],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.code !== 0, "a missing tag list must fail the step");
    assertEquals(new TextDecoder().decode(out.stdout), "");
    assertStringIncludes(
      new TextDecoder().decode(out.stderr),
      "no such file",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("next-release-tag - a missing argument fails loud", async () => {
  const out = await new Deno.Command("bash", {
    args: [SCRIPT_PATH],
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.code !== 0, "no arguments must fail the step");
  assertEquals(new TextDecoder().decode(out.stdout), "");
});
