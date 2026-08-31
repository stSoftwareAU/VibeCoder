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
    assertEquals(await runPlan(), "should_tag=false\ntag=\n");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
