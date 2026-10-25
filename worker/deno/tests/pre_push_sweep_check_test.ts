/**
 * Tests for the pre-push sweptAt ancestry check (Issue #3689), against real
 * temporary git repositories so ancestry is genuine.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  checkSweptAtAncestry,
  touchesSweepLedger,
} from "../lib/pre_push_sweep_check.ts";
import {
  defaultPrePushGit,
  PrePushGateInfrastructureError,
  runPrePushGate,
} from "../lib/pre_push_gate.ts";

const TOP_UP = "docs/audits/lib-sweep-coverage/top-up-5000.json";
const LEDGER = "docs/audits/lib-sweep-coverage.json";

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

function slice(issue: number, chunk: string, sweptAt: string) {
  return {
    issue,
    chunk,
    title: "fixture",
    ledger: "docs/audits/fixture.md",
    definition: "fixture",
    status: "swept",
    sweptAt,
    paths: [`worker/deno/lib/fixture_${issue}.ts`],
  };
}

async function writeJson(path: string, value: unknown) {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2) + "\n");
}

interface Fixture {
  root: string;
  clone: string;
  origin: string;
  firstMain: string;
  secondMain: string;
}

/** Bare origin with two main commits; `clone` is a full clone on main. */
async function makeFixture(): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "vibe-pp-sweep-" });
  const origin = `${root}/origin.git`;
  const clone = `${root}/clone`;
  await git(root, "init", "-q", "--bare", "-b", "main", origin);
  await git(root, "clone", "-q", origin, clone);
  await writeJson(`${clone}/${LEDGER}`, {
    roots: ["worker/deno/lib"],
    parent: 1,
    description: "fixture",
    slices: [slice(1, "12a", "0".repeat(40))],
  });
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "first");
  const firstMain = await git(clone, "rev-parse", "HEAD");
  await Deno.writeTextFile(`${clone}/note.txt`, "two\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "second");
  const secondMain = await git(clone, "rev-parse", "HEAD");
  await git(clone, "push", "-q", "origin", "HEAD:main");
  await git(clone, "fetch", "-q", "origin");
  await git(clone, "remote", "set-head", "origin", "main");
  return { root, clone, origin, firstMain, secondMain };
}

async function commitTopUp(clone: string, sweptAt: string): Promise<string> {
  await writeJson(`${clone}/${TOP_UP}`, slice(5000, "top-up-5000", sweptAt));
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "top-up");
  return await git(clone, "rev-parse", "HEAD");
}

const cleanup = (root: string) => Deno.remove(root, { recursive: true });

Deno.test("touchesSweepLedger: only the ledger and its top-up files count", () => {
  assert(touchesSweepLedger([LEDGER]));
  assert(touchesSweepLedger([TOP_UP]));
  assert(!touchesSweepLedger(["docs/audits/lib-sweep-coverage/notes.md"]));
  assert(!touchesSweepLedger(["README.md"]));
});

Deno.test("checkSweptAtAncestry: a top-up whose sweptAt is a main commit passes", async () => {
  const f = await makeFixture();
  try {
    await git(f.clone, "checkout", "-qb", "feat");
    await commitTopUp(f.clone, f.firstMain);
    const result = await checkSweptAtAncestry({
      cwd: f.clone,
      changed: [TOP_UP],
      git: defaultPrePushGit,
    });
    assert(result.ok, result.ok ? "" : result.error);
  } finally {
    await cleanup(f.root);
  }
});

Deno.test("checkSweptAtAncestry: a branch-only sweptAt is repointed to the merge base", async () => {
  const f = await makeFixture();
  try {
    await git(f.clone, "checkout", "-qb", "feat");
    await Deno.writeTextFile(`${f.clone}/branch.txt`, "b\n");
    await git(f.clone, "add", ".");
    await git(f.clone, "commit", "-qm", "branch only");
    const branchSha = await git(f.clone, "rev-parse", "HEAD");
    const mergeBase = await git(f.clone, "merge-base", "origin/main", "HEAD");
    await commitTopUp(f.clone, branchSha);
    const result = await checkSweptAtAncestry({
      cwd: f.clone,
      changed: [TOP_UP],
      git: defaultPrePushGit,
    });
    assert(result.ok, result.ok ? "" : result.error);
    const onDisk = JSON.parse(await Deno.readTextFile(`${f.clone}/${TOP_UP}`));
    assertEquals(onDisk.sweptAt, mergeBase);
    assert(onDisk.sweptAt !== branchSha);
  } finally {
    await cleanup(f.root);
  }
});

Deno.test("checkSweptAtAncestry: only changed slices are checked", async () => {
  const f = await makeFixture();
  try {
    // The ledger file's own slice has an unresolvable sweptAt, but only the
    // top-up file changed, so it must not be blamed.
    await commitTopUp(f.clone, f.firstMain);
    const result = await checkSweptAtAncestry({
      cwd: f.clone,
      changed: [TOP_UP],
      git: defaultPrePushGit,
    });
    assert(result.ok, result.ok ? "" : result.error);
    const untouched = JSON.parse(
      await Deno.readTextFile(`${f.clone}/${LEDGER}`),
    );
    assertEquals(untouched.slices[0].sweptAt, "0".repeat(40));
    const ledgerChanged = await checkSweptAtAncestry({
      cwd: f.clone,
      changed: [LEDGER],
      git: defaultPrePushGit,
    });
    assert(ledgerChanged.ok, ledgerChanged.ok ? "" : ledgerChanged.error);
    const repaired = JSON.parse(
      await Deno.readTextFile(`${f.clone}/${LEDGER}`),
    );
    assertEquals(repaired.slices[0].sweptAt, f.secondMain);
  } finally {
    await cleanup(f.root);
  }
});

Deno.test("checkSweptAtAncestry: a branch-only sweptAt on the ledger file's own top-up slice is repointed", async () => {
  const f = await makeFixture();
  try {
    await git(f.clone, "checkout", "-qb", "feat");
    await Deno.writeTextFile(`${f.clone}/branch.txt`, "b\n");
    await git(f.clone, "add", ".");
    await git(f.clone, "commit", "-qm", "branch only");
    const branchSha = await git(f.clone, "rev-parse", "HEAD");
    const mergeBase = await git(f.clone, "merge-base", "origin/main", "HEAD");
    // The ledger file holds in-file `top-up-<n>` slices for issues up to
    // LEDGER_FILE_LAST_TOP_UP_ISSUE; a changed one must still be checked.
    await writeJson(`${f.clone}/${LEDGER}`, {
      roots: ["worker/deno/lib"],
      parent: 1,
      description: "fixture",
      slices: [
        slice(1, "12a", f.firstMain),
        slice(1885, "top-up-1885", branchSha),
      ],
    });
    await git(f.clone, "add", ".");
    await git(f.clone, "commit", "-qm", "ledger");
    const result = await checkSweptAtAncestry({
      cwd: f.clone,
      changed: [LEDGER],
      git: defaultPrePushGit,
    });
    assert(result.ok, result.ok ? "" : result.error);
    const onDisk = JSON.parse(await Deno.readTextFile(`${f.clone}/${LEDGER}`));
    assertEquals(onDisk.slices[0].sweptAt, f.firstMain);
    assertEquals(onDisk.slices[1].sweptAt, mergeBase);
  } finally {
    await cleanup(f.root);
  }
});

Deno.test("checkSweptAtAncestry: a shallow clone is deepened and an older main sweptAt passes", async () => {
  const f = await makeFixture();
  const shallow = `${f.root}/shallow`;
  try {
    await git(
      f.root,
      "clone",
      "-q",
      "--depth=1",
      "--no-single-branch",
      `file://${f.origin}`,
      shallow,
    );
    assertEquals(
      await git(shallow, "rev-parse", "--is-shallow-repository"),
      "true",
    );
    await git(shallow, "checkout", "-qb", "feat");
    await commitTopUp(shallow, f.firstMain);
    const result = await checkSweptAtAncestry({
      cwd: shallow,
      changed: [TOP_UP],
      git: defaultPrePushGit,
    });
    assert(result.ok, result.ok ? "" : result.error);
  } finally {
    await cleanup(f.root);
  }
});

Deno.test("checkSweptAtAncestry: an unresolvable default ref blocks", async () => {
  const f = await makeFixture();
  try {
    await commitTopUp(f.clone, f.firstMain);
    await git(f.clone, "remote", "set-head", "origin", "--delete");
    const result = await checkSweptAtAncestry({
      cwd: f.clone,
      changed: [TOP_UP],
      git: defaultPrePushGit,
    });
    assert(!result.ok);
    assert(result.error.includes("default branch"), result.error);
    const explicit = await checkSweptAtAncestry({
      cwd: f.clone,
      changed: [TOP_UP],
      git: defaultPrePushGit,
      defaultRef: "origin/nonexistent",
    });
    assert(!explicit.ok);
    assert(explicit.error.includes("origin/nonexistent"), explicit.error);
  } finally {
    await cleanup(f.root);
  }
});

Deno.test("checkSweptAtAncestry: a failed history deepen is infrastructure, a branch-only sweptAt is not (PR #3716 review)", async () => {
  const f = await makeFixture();
  try {
    await git(f.clone, "checkout", "-qb", "feat");
    await Deno.writeTextFile(`${f.clone}/branch.txt`, "b\n");
    await git(f.clone, "add", ".");
    await git(f.clone, "commit", "-qm", "branch only");
    const branchSha = await git(f.clone, "rev-parse", "HEAD");
    const tip = await commitTopUp(f.clone, branchSha);

    // With git answering, the branch commit is repointed before the check.
    const verdict = await checkSweptAtAncestry({
      cwd: f.clone,
      changed: [TOP_UP],
      git: defaultPrePushGit,
    });
    assert(verdict.ok, verdict.ok ? "" : verdict.error);
    const repaired = JSON.parse(
      await Deno.readTextFile(`${f.clone}/${TOP_UP}`),
    );
    assertEquals(
      repaired.sweptAt,
      await git(f.clone, "merge-base", "origin/main", "HEAD"),
    );

    // The clone reads as shallow and every fetch fails: the check could not run.
    const outage: typeof defaultPrePushGit = (args, cwd) => {
      if (args[0] === "rev-parse" && args.includes("--is-shallow-repository")) {
        return Promise.resolve({ code: 0, stdout: "true\n", stderr: "" });
      }
      // The pushed sweptAt reads as missing locally, so the check must unshallow.
      if (args[0] === "cat-file") {
        return Promise.resolve({ code: 1, stdout: "", stderr: "" });
      }
      if (args[0] === "fetch") {
        return Promise.resolve({
          code: 128,
          stdout: "",
          stderr: "fatal: unable to access 'https://github.com/o/r.git/'",
        });
      }
      return defaultPrePushGit(args, cwd);
    };
    const result = await checkSweptAtAncestry({
      cwd: f.clone,
      changed: [TOP_UP],
      git: outage,
    });
    assert(!result.ok);
    assertEquals(result.infrastructure, true);
    assert(result.error.includes("could not deepen"), result.error);

    // The other two ways the check can fail to run are infrastructure too.
    const shallowUnknown = await checkSweptAtAncestry({
      cwd: f.clone,
      changed: [TOP_UP],
      git: (args, cwd) =>
        args[0] === "rev-parse" && args.includes("--is-shallow-repository")
          ? Promise.resolve({ code: 128, stdout: "", stderr: "fatal: oops" })
          : defaultPrePushGit(args, cwd),
    });
    assert(!shallowUnknown.ok);
    assertEquals(shallowUnknown.infrastructure, true);
    assert(
      shallowUnknown.error.includes("whether the clone is shallow"),
      shallowUnknown.error,
    );

    const cannotDeepen = await checkSweptAtAncestry({
      cwd: f.clone,
      changed: [TOP_UP],
      git: (args, cwd) =>
        args[0] === "merge-base"
          ? Promise.resolve({ code: 1, stdout: "", stderr: "" })
          : outage(args, cwd),
    });
    assert(!cannotDeepen.ok);
    assertEquals(cannotDeepen.infrastructure, true);
    assert(cannotDeepen.error.includes("could not deepen"), cannotDeepen.error);

    // Through the whole gate it is an infrastructure error, not a verdict.
    const gate = await runPrePushGate({
      cwd: f.clone,
      stdin: `refs/heads/feat ${tip} refs/heads/feat ${"0".repeat(40)}\n`,
      preFlightCommands: [],
      git: outage,
    });
    assert(!gate.ok);
    assert(gate.error instanceof PrePushGateInfrastructureError);
    assert(gate.error.message.includes("could not deepen"), gate.error.message);
  } finally {
    await cleanup(f.root);
  }
});

Deno.test("runPrePushGate: a branch-only sweptAt in a pushed top-up is repointed and the push passes", async () => {
  const f = await makeFixture();
  try {
    await git(f.clone, "checkout", "-qb", "feat");
    await Deno.writeTextFile(`${f.clone}/branch.txt`, "b\n");
    await git(f.clone, "add", ".");
    await git(f.clone, "commit", "-qm", "branch only");
    const branchSha = await git(f.clone, "rev-parse", "HEAD");
    const mergeBase = await git(f.clone, "merge-base", "origin/main", "HEAD");
    const tip = await commitTopUp(f.clone, branchSha);
    const stdin = `refs/heads/feat ${tip} refs/heads/feat ${"0".repeat(40)}\n`;
    const result = await runPrePushGate({
      cwd: f.clone,
      stdin,
      preFlightCommands: [],
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    const onDisk = JSON.parse(await Deno.readTextFile(`${f.clone}/${TOP_UP}`));
    assertEquals(onDisk.sweptAt, mergeBase);
    const committed = JSON.parse(await git(f.clone, "show", `HEAD:${TOP_UP}`));
    assertEquals(committed.sweptAt, mergeBase);
  } finally {
    await cleanup(f.root);
  }
});

Deno.test("runPrePushGate: an agent-recorded branch-commit sweptAt is repointed to the merge base and the push passes (Issue #4235)", async () => {
  const f = await makeFixture();
  try {
    await git(f.clone, "checkout", "-qb", "feat");
    await Deno.writeTextFile(`${f.clone}/branch.txt`, "b\n");
    await git(f.clone, "add", ".");
    await git(f.clone, "commit", "-qm", "branch only");
    const branchSha = await git(f.clone, "rev-parse", "HEAD");
    const mergeBase = await git(f.clone, "merge-base", "origin/main", "HEAD");
    assert(mergeBase !== branchSha);
    assert(mergeBase === f.secondMain, mergeBase);
    await writeJson(`${f.clone}/${LEDGER}`, {
      roots: ["worker/deno/lib"],
      parent: 1,
      description: "fixture",
      slices: [slice(1, "12a", branchSha)],
    });
    await git(f.clone, "add", ".");
    await git(f.clone, "commit", "-qm", "agent wrote a branch sweptAt");
    const tip = await git(f.clone, "rev-parse", "HEAD");
    const result = await runPrePushGate({
      cwd: f.clone,
      stdin: `refs/heads/feat ${tip} refs/heads/feat ${"0".repeat(40)}\n`,
      preFlightCommands: [],
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    const onDisk = JSON.parse(await Deno.readTextFile(`${f.clone}/${LEDGER}`));
    assertEquals(onDisk.slices[0].sweptAt, mergeBase);
    const committed = JSON.parse(
      await git(f.clone, "show", `HEAD:${LEDGER}`),
    );
    assertEquals(committed.slices[0].sweptAt, mergeBase);
    await git(f.clone, "merge-base", "--is-ancestor", mergeBase, "origin/main");
  } finally {
    await cleanup(f.root);
  }
});

Deno.test("checkSweptAtAncestry: a failed merge-base is an error and keeps the branch sweptAt unpushed (Issue #4235)", async () => {
  const f = await makeFixture();
  try {
    await git(f.clone, "checkout", "-qb", "feat");
    await Deno.writeTextFile(`${f.clone}/branch.txt`, "b\n");
    await git(f.clone, "add", ".");
    await git(f.clone, "commit", "-qm", "branch only");
    const branchSha = await git(f.clone, "rev-parse", "HEAD");
    await commitTopUp(f.clone, branchSha);
    const result = await checkSweptAtAncestry({
      cwd: f.clone,
      changed: [TOP_UP],
      git: (args, cwd) => {
        if (
          args[0] === "merge-base" && args[1] === "origin/main" &&
          args[2] === "HEAD"
        ) {
          return Promise.resolve({
            code: 128,
            stdout: "",
            stderr: "fatal: Not a valid object name origin/main",
          });
        }
        return defaultPrePushGit(args, cwd);
      },
    });
    assert(!result.ok);
    assert(result.error.includes("merge-base origin/main HEAD"), result.error);
    assert(!result.error.includes("WARNING:"));
    assert(!result.error.includes("ERROR:"));
    const onDisk = JSON.parse(await Deno.readTextFile(`${f.clone}/${TOP_UP}`));
    assertEquals(onDisk.sweptAt, branchSha);
  } finally {
    await cleanup(f.root);
  }
});

Deno.test("runPrePushGate: no sweep file changed means no sweep git calls", async () => {
  const f = await makeFixture();
  try {
    await Deno.writeTextFile(`${f.clone}/other.txt`, "x\n");
    await git(f.clone, "add", ".");
    await git(f.clone, "commit", "-qm", "other");
    const tip = await git(f.clone, "rev-parse", "HEAD");
    const calls: string[][] = [];
    const result = await runPrePushGate({
      cwd: f.clone,
      stdin: `refs/heads/main ${tip} refs/heads/main ${"0".repeat(40)}\n`,
      preFlightCommands: [],
      git: (args, cwd) => {
        calls.push(args);
        return defaultPrePushGit(args, cwd);
      },
    });
    assert(result.ok);
    const sweepCalls = calls.filter((a) =>
      ["symbolic-ref", "merge-base", "cat-file", "rev-parse", "fetch"]
        .includes(a[0]!)
    );
    assertEquals(sweepCalls, []);
  } finally {
    await cleanup(f.root);
  }
});
