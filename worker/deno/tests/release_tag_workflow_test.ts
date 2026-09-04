/**
 * Tests for `.github/workflows/release-tag.yml` (Issue #627): every merge
 * to `main` is tagged with the next auto-incremented patch semver, so a
 * frozen host has released versions to pin to.
 *
 * The trigger only exists post-merge, so the workflow structure is
 * asserted from the parsed YAML (not source text), and the plumbing
 * between git and the increment script is exercised against a real
 * throwaway repository.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";

/** Resolve the repository root (three levels up from worker/deno/tests/). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

interface Step {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
}
interface Job {
  "runs-on"?: string;
  "timeout-minutes"?: number;
  permissions?: Record<string, string>;
  steps?: Step[];
}
interface ReleaseTagWorkflow {
  on?: { push?: { branches?: string[] } };
  permissions?: Record<string, string>;
  concurrency?: { group?: string; "cancel-in-progress"?: boolean };
  jobs?: Record<string, Job>;
}

async function loadWorkflow(): Promise<ReleaseTagWorkflow> {
  const path = `${repoRoot()}.github/workflows/release-tag.yml`;
  return parseYaml(await Deno.readTextFile(path)) as ReleaseTagWorkflow;
}

function tagJob(wf: ReleaseTagWorkflow): Job {
  const job = wf.jobs?.tag;
  assert(job, "release-tag.yml must define the `tag` job");
  return job;
}

Deno.test("release-tag.yml - fires on a push to main, nothing else", async () => {
  const wf = await loadWorkflow();
  // `on:` is the YAML boolean `true` unless quoted, so read it either way.
  const triggers = (wf.on ?? (wf as Record<string, unknown>)["true"]) as {
    push?: { branches?: string[] };
  };
  assertEquals(Object.keys(triggers), ["push"]);
  assertEquals(triggers.push?.branches, ["main"]);
});

Deno.test("release-tag.yml - only the tagging job holds contents: write", async () => {
  const wf = await loadWorkflow();
  assertEquals(wf.permissions, { contents: "read" });
  assertEquals(tagJob(wf).permissions, { contents: "write" });
});

Deno.test("release-tag.yml - concurrent pushes serialise rather than cancel", async () => {
  const wf = await loadWorkflow();
  assert(wf.concurrency?.group, "a concurrency group is required");
  // Cancelling would drop the tag for a merge that has already landed.
  assertEquals(wf.concurrency?.["cancel-in-progress"], false);
});

Deno.test("release-tag.yml - the checkout is SHA-pinned, tag-complete and credential-free", async () => {
  const steps = tagJob(await loadWorkflow()).steps ?? [];
  const checkout = steps.find((s) => s.uses?.startsWith("actions/checkout@"));
  assert(checkout, "the job must check the repository out");
  const ref = checkout.uses?.split("@")[1] ?? "";
  assert(/^[0-9a-f]{40}$/.test(ref), `checkout is not SHA-pinned: ${ref}`);
  // A shallow clone would hide the newest tag from the version selection.
  assertEquals(checkout.with?.["fetch-depth"], 0);
  assertEquals(checkout.with?.["persist-credentials"], false);
});

Deno.test("release-tag.yml - the tag is created only when the plan says so", async () => {
  const steps = tagJob(await loadWorkflow()).steps ?? [];
  const plan = steps.find((s) => s.id === "plan");
  assert(plan, "the job must plan the tag before creating it");
  assert(
    plan.run?.includes(".github/scripts/next-release-tag.sh"),
    "the plan step must use the tested increment script",
  );
  assert(
    plan.run?.includes("GITHUB_OUTPUT"),
    "the plan must be published as step outputs",
  );
  const create = steps.find((s) => s.run?.includes("git/refs"));
  assert(create, "the job must create the tag ref");
  assertEquals(create.if, "steps.plan.outputs.should_tag == 'true'");
  // The tag name reaches the shell through the environment; interpolating
  // it into the script body is the template-injection shape.
  assertEquals(create.env?.["TAG"], "${{ steps.plan.outputs.tag }}");
  assert(
    !create.run?.includes("${{"),
    "no ${{ }} expansion may appear inside a run: body",
  );
});

Deno.test("release-tag.yml - the plan is given the repository's release floor", async () => {
  const steps = tagJob(await loadWorkflow()).steps ?? [];
  const plan = steps.find((s) => s.id === "plan");
  assert(plan, "the job must plan the tag before creating it");
  // Issue #808: without the floor the workflow can only ever mint the next
  // patch, so a release that moves the series would have to be tagged by
  // hand and the automation would fight it on the following merge.
  assert(
    plan.run?.includes(".release-floor"),
    "the plan step must pass the repository's release floor to the script",
  );
});

Deno.test("release-tag.yml - a created release points at the release notes", async () => {
  const publish = publishStep(tagJob(await loadWorkflow()).steps ?? []);
  const run = publish.run ?? "";
  // Issue #808: the notes are where a breaking release states the removed
  // configuration keys and the migration; a release body naming only the
  // tool-version asset leaves an operator nothing to read before upgrading.
  assert(
    run.includes("docs/RELEASE-NOTES.md"),
    "the release body must link the release notes",
  );
});

/** The step that publishes the tool-version manifest (Issue #688). */
function publishStep(steps: Step[]): Step {
  const publish = steps.find((s) => s.run?.includes("release-manifest"));
  assert(publish, "the job must publish the release tool-version manifest");
  return publish;
}

Deno.test("release-tag.yml - the manifest is published for the commit's release tag", async () => {
  const steps = tagJob(await loadWorkflow()).steps ?? [];
  const publish = publishStep(steps);
  // Keyed off the tag itself, not off should_tag: a re-run after a failed
  // publish must still be able to publish for the tag already on the commit.
  assertEquals(publish.if, "steps.plan.outputs.tag != ''");
  assertEquals(publish.env?.["TAG"], "${{ steps.plan.outputs.tag }}");
  assertEquals(publish.env?.["ASSET"], "tool-versions.json");
  assert(
    !publish.run?.includes("${{"),
    "no ${{ }} expansion may appear inside a run: body",
  );
});

Deno.test("release-tag.yml - the tag is created before anything is published", async () => {
  const steps = tagJob(await loadWorkflow()).steps ?? [];
  const create = steps.findIndex((s) => s.run?.includes("git/refs"));
  const publish = steps.indexOf(publishStep(steps));
  // The tag stays the workflow's first side effect: publishing the manifest
  // must never gate, delay or roll back the tag a merge has already earned.
  assert(create < publish, "the tag must be created before the manifest");
});

Deno.test("release-tag.yml - a release already carrying the asset is left alone", async () => {
  const publish = publishStep(tagJob(await loadWorkflow()).steps ?? []);
  const run = publish.run ?? "";
  assert(
    run.includes("gh release view") && run.includes("assets"),
    "the publish must check for the asset before minting a new one",
  );
  assert(
    run.includes("gh release upload") && run.includes("gh release create"),
    "an existing release takes an upload; a missing one takes a create",
  );
  // --verify-tag: never mint a release for a tag that does not exist.
  assert(run.includes("--verify-tag"), "the release must verify the tag");
});

Deno.test("release-tag.yml - the manifest generator runs on the pinned toolchain", async () => {
  const steps = tagJob(await loadWorkflow()).steps ?? [];
  const setup = steps.find((s) => s.uses?.startsWith("denoland/setup-deno@"));
  assert(setup, "the job must install Deno to mint the manifest");
  const ref = setup.uses?.split("@")[1] ?? "";
  assert(/^[0-9a-f]{40}$/.test(ref), `setup-deno is not SHA-pinned: ${ref}`);
  assertEquals(setup.with?.["deno-version-file"], ".deno-version");
  assertEquals(setup.if, "steps.plan.outputs.tag != ''");

  const run = publishStep(steps).run ?? "";
  assert(
    run.includes("worker/deno/mod.ts release-manifest --release"),
    "the manifest must come from the tested command, not inline shell",
  );
  assert(
    run.includes("--lock=worker/deno/deno.lock") && run.includes("--frozen"),
    "the generator must run against the frozen dependency lock",
  );
});

/** Run a git command in `cwd`, returning its trimmed stdout. */
async function git(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout).trim();
}

Deno.test("release-tag - the plan step reads real git tag output", async () => {
  const dir = await Deno.makeTempDir({ prefix: "release_tag_plan_" });
  try {
    await git(["init", "-q", "-b", "main"], dir);
    await git(["config", "commit.gpgsign", "false"], dir);
    await git(["config", "user.email", "test@example.com"], dir);
    await git(["config", "user.name", "test"], dir);
    await Deno.writeTextFile(`${dir}/file.txt`, "one\n");
    await git(["add", "file.txt"], dir);
    await git(["commit", "-qm", "first"], dir);
    await git(["tag", "1.0.9"], dir);
    await Deno.writeTextFile(`${dir}/file.txt`, "two\n");
    await git(["commit", "-qam", "second"], dir);
    const head = await git(["rev-parse", "HEAD"], dir);

    // Exactly what the workflow step runs, against real git output.
    const script = `${repoRoot()}.github/scripts/next-release-tag.sh`;
    const runPlan = async () => {
      await Deno.writeTextFile(
        `${dir}/all-tags.txt`,
        `${await git(["tag", "--list"], dir)}\n`,
      );
      await Deno.writeTextFile(
        `${dir}/head-tags.txt`,
        `${await git(["tag", "--points-at", head], dir)}\n`,
      );
      const out = await new Deno.Command("bash", {
        args: [script, `${dir}/all-tags.txt`, `${dir}/head-tags.txt`],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
      return new TextDecoder().decode(out.stdout);
    };

    assertEquals(await runPlan(), "should_tag=true\ntag=1.0.10\n");

    // Re-running after the tag exists is a no-op, not a second tag.
    await git(["tag", "1.0.10", head], dir);
    assertEquals(await runPlan(), "should_tag=false\ntag=1.0.10\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
