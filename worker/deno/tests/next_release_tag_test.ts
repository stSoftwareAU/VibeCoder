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
 * Issue #808 added the optional third input, the release floor: the one file
 * a human edits to move the series off the automatic patch increment. The
 * floor is only ever raised INTO the mint, never sticky, so the tests below
 * cover both the merge that mints it and every merge after it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const SCRIPT_PATH =
  new URL("../../../.github/scripts/next-release-tag.sh", import.meta.url)
    .pathname;

/** The repository's own release floor — the version the next release mints. */
const FLOOR_PATH = new URL("../../../.release-floor", import.meta.url).pathname;

interface PlanRun {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run the script over the two tag lists, in a throwaway directory. When
 * `floor` is given it is written to a third file and passed as the release
 * floor (Issue #808); omitting it is the caller that names no floor at all.
 */
async function plan(
  allTags: string[],
  headTags: string[],
  floor?: string,
): Promise<PlanRun> {
  const dir = await Deno.makeTempDir({ prefix: "next_release_tag_" });
  try {
    const allFile = `${dir}/all-tags.txt`;
    const headFile = `${dir}/head-tags.txt`;
    await Deno.writeTextFile(allFile, allTags.map((t) => `${t}\n`).join(""));
    await Deno.writeTextFile(headFile, headTags.map((t) => `${t}\n`).join(""));
    const args = [SCRIPT_PATH, allFile, headFile];
    if (floor !== undefined) {
      const floorFile = `${dir}/release-floor`;
      await Deno.writeTextFile(floorFile, floor);
      args.push(floorFile);
    }
    const out = await new Deno.Command("bash", {
      args,
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
  // Issue #688 changed the `tag` output on this path from empty to the tag
  // the commit already carries: the manifest publish downstream keys off it,
  // so a re-run after a failed publish still names a release to publish for.
  assertEquals(outputs(run), { should_tag: "false", tag: "1.0.1" });
  assertStringIncludes(run.stderr, "already tagged");
});

Deno.test("next-release-tag - the newest release tag on the commit is the one reported", async () => {
  const run = await plan(["1.0.9", "1.0.10"], ["v1.0.9", "1.0.10"]);
  assertEquals(outputs(run), { should_tag: "false", tag: "1.0.10" });
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

// --- The release floor (Issue #808) -----------------------------------

Deno.test("next-release-tag - a floor above the series is minted instead of the patch", async () => {
  // The 1.1.0 release itself: the newest tag is a 1.0.x patch, and the
  // automatic increment (1.0.72) would ship the breaking callback contract
  // as another patch.
  const run = await plan(["1.0.70", "1.0.71"], [], "1.1.0\n");
  assertEquals(run.code, 0);
  assertEquals(outputs(run), { should_tag: "true", tag: "1.1.0" });
  assertStringIncludes(run.stderr, "release floor 1.1.0 raises 1.0.72");
});

Deno.test("next-release-tag - the merge after the floor release continues from it", async () => {
  // The floor is not sticky: once its release exists the patch increment is
  // already above it, so the file can be left in place.
  const run = await plan(["1.0.71", "1.1.0"], [], "1.1.0\n");
  assertEquals(outputs(run), { should_tag: "true", tag: "1.1.1" });
  assertEquals(run.stderr.includes("release floor"), false);
});

Deno.test("next-release-tag - a floor at or below the series changes nothing", async () => {
  const at = await plan(["1.1.0"], [], "1.1.0\n");
  assertEquals(outputs(at), { should_tag: "true", tag: "1.1.1" });
  const below = await plan(["1.2.4"], [], "1.1.0\n");
  assertEquals(outputs(below), { should_tag: "true", tag: "1.2.5" });
});

Deno.test("next-release-tag - a floor decides the first tag of an untagged repository", async () => {
  const run = await plan([], [], "1.1.0\n");
  assertEquals(outputs(run), { should_tag: "true", tag: "1.1.0" });
});

Deno.test("next-release-tag - a floor never re-tags a commit that already carries a release", async () => {
  // Idempotency wins over the floor: the release the commit already carries
  // is reported, so a re-run publishes for it rather than minting a second.
  const run = await plan(["1.0.71"], ["1.0.71"], "1.1.0\n");
  assertEquals(outputs(run), { should_tag: "false", tag: "1.0.71" });
});

Deno.test("next-release-tag - comments and blank lines in the floor file are ignored", async () => {
  const run = await plan(
    ["1.0.71"],
    [],
    "# why the series moves\n\n1.1.0  # the release\n",
  );
  assertEquals(outputs(run), { should_tag: "true", tag: "1.1.0" });
});

Deno.test("next-release-tag - a floor file with no version at all is no floor", async () => {
  const run = await plan(["1.0.71"], [], "# the series moves by hand\n");
  assertEquals(outputs(run), { should_tag: "true", tag: "1.0.72" });
});

Deno.test("next-release-tag - a malformed floor fails loud, it is not ignored", async () => {
  // Silently ignoring a typo would ship the release under the automatic
  // patch number, which is the exact mistake the floor exists to prevent.
  for (const bad of ["1.1\n", "v1.1.0-rc1\n", "next\n"]) {
    const run = await plan(["1.0.71"], [], bad);
    assert(run.code !== 0, `a malformed floor must fail the step: ${bad}`);
    assertEquals(run.stdout, "");
    assertStringIncludes(run.stderr, "not a release version");
  }
});

Deno.test("next-release-tag - a floor file naming two versions fails loud", async () => {
  const run = await plan(["1.0.71"], [], "1.1.0\n2.0.0\n");
  assert(run.code !== 0, "an ambiguous floor must fail the step");
  assertEquals(run.stdout, "");
  assertStringIncludes(run.stderr, "more than one version");
});

Deno.test("next-release-tag - a floor file that was named but is absent fails loud", async () => {
  const dir = await Deno.makeTempDir({ prefix: "next_release_tag_floor_" });
  try {
    const allFile = `${dir}/all-tags.txt`;
    const headFile = `${dir}/head-tags.txt`;
    await Deno.writeTextFile(allFile, "1.0.71\n");
    await Deno.writeTextFile(headFile, "");
    const out = await new Deno.Command("bash", {
      args: [SCRIPT_PATH, allFile, headFile, `${dir}/absent`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert(out.code !== 0, "a named-but-missing floor must fail the step");
    assertEquals(new TextDecoder().decode(out.stdout), "");
    assertStringIncludes(new TextDecoder().decode(out.stderr), "no such file");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("next-release-tag - the repository's own floor mints 1.3.0 over the 1.0.x series", async () => {
  // Issue #808: the acceptance criterion itself. `.release-floor` is the one
  // line that decides the number, so it is asserted through the real script
  // against the series the fleet is actually on.
  const dir = await Deno.makeTempDir({ prefix: "next_release_tag_repo_" });
  try {
    const allFile = `${dir}/all-tags.txt`;
    const headFile = `${dir}/head-tags.txt`;
    await Deno.writeTextFile(allFile, "1.0.70\n1.0.71\n");
    await Deno.writeTextFile(headFile, "");
    const out = await new Deno.Command("bash", {
      args: [SCRIPT_PATH, allFile, headFile, FLOOR_PATH],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
    assertEquals(
      new TextDecoder().decode(out.stdout),
      "should_tag=true\ntag=1.3.0\n",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("next-release-tag - the release floor is not ignored by git", async () => {
  // `.gitignore` ignores every hidden file by default. The workflow reads the
  // floor out of the checkout and fails the step when it is named but absent,
  // so an ignored floor would turn every merge to `main` into a red run.
  const out = await new Deno.Command("git", {
    args: ["check-ignore", "-q", ".release-floor"],
    cwd: new URL("../../../", import.meta.url).pathname,
    stdout: "null",
    stderr: "null",
  }).output();
  assertEquals(out.code, 1, ".release-floor must be committed, not ignored");
});
