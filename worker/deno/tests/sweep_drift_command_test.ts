/**
 * Tests for the sweep-drift command (Issue #1609).
 *
 * The command formats one block per slice. Git is injected, so the formatting
 * and collection tests never spawn a real process. The one exception is the
 * `sweepGitRunnerFor` test (Issue #2178), which builds a throwaway repository
 * to prove the runner resolves repo-relative pathspecs against `--repo`.
 *
 * Australian English spelling throughout.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  collectSweepDrift,
  formatSweepDriftReport,
  sweepDriftCommand,
  sweepGitRunnerFor,
} from "../commands/sweep_drift.ts";
import {
  LIB_SWEEP_TOP_UP_DIR,
  readCoverageLedger,
  type SweepCoverageLedger,
  topUpChunkId,
  verifySweptAtsOnDefaultBranch,
} from "../lib/lib_sweep_coverage.ts";

import {
  commitFile,
  git,
  gitOk,
  setupGitRepoFixture,
} from "./support/git_repo_fixture.ts";

const COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/** The sweptAt of the top-up slice, distinct from the ledger file's. */
const TOP_UP_COMMIT = "cccccccccccccccccccccccccccccccccccccccc";
const TOP_UP_ISSUE = 3300;

function ledger(): SweepCoverageLedger {
  return {
    roots: ["worker/deno/lib"],
    parent: 1209,
    description: "fixture",
    slices: [
      {
        issue: 1214,
        chunk: "12a",
        title: "subprocess",
        ledger: "docs/audits/a.md",
        definition: "fixture",
        status: "swept",
        sweptAt: COMMIT,
        paths: ["worker/deno/lib/a.ts"],
      },
    ],
  };
}

Deno.test("formatSweepDriftReport - prints one block per slice with counts and paths (Issue #1609)", () => {
  const text = formatSweepDriftReport([{
    chunk: "12a",
    issue: 1214,
    title: "subprocess",
    sweptAt: COMMIT,
    drift: {
      added: ["worker/deno/lib/new.ts"],
      modified: ["worker/deno/lib/a.ts"],
      unowned: [],
    },
  }]);
  assertEquals(
    text.includes("## 12a (#1214) subprocess"),
    true,
  );
  assertEquals(text.includes("added (1):"), true);
  assertEquals(text.includes("  - worker/deno/lib/new.ts"), true);
  assertEquals(text.includes("modified (1):"), true);
  assertEquals(text.includes("unowned (0):"), true);
});

Deno.test("collectSweepDrift - one block per slice from the injected runner (Issue #1609)", async () => {
  const blocks = await collectSweepDrift(
    ledger(),
    ["worker/deno/lib/a.ts"],
    (args) => {
      if (args.includes("--diff-filter=M")) {
        return Promise.resolve({
          code: 0,
          stdout: "worker/deno/lib/a.ts\n",
          stderr: "",
        });
      }
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
  );
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0]?.chunk, "12a");
  assertEquals(blocks[0]?.drift.modified, ["worker/deno/lib/a.ts"]);
  assertEquals(blocks[0]?.drift.added, []);
});

Deno.test("sweep-drift command - is registered under the documented name (Issue #1609)", () => {
  assertEquals(sweepDriftCommand.name, "sweep-drift");
});

Deno.test("sweepGitRunnerFor - resolves repo-relative pathspecs against --repo, not the process cwd (Issue #2178)", async () => {
  // Fail direction: before this change the runner spawned git in the worker's
  // own working directory, so `-- worker/deno/lib` matched nothing whenever
  // that directory was not the repository root and every slice reported an
  // empty drift — a clean report for a ledger nobody had diffed.
  const repoRoot = await Deno.makeTempDir({ prefix: "sweep-drift-" });
  const git = async (...args: string[]) => {
    const { code, stderr } = await new Deno.Command("git", {
      args,
      cwd: repoRoot,
      stdout: "null",
      stderr: "piped",
    }).output();
    // Carry git's own reason, never just the exit code: a fixture that fails
    // for an unrelated reason must say which one.
    assertEquals(
      code,
      0,
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  };
  try {
    await git("init", "--quiet");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");
    // The fixture must not inherit the host's signing config, or a developer
    // with `commit.gpgsign=true` globally gets a red suite for no reason.
    await git("config", "commit.gpgsign", "false");
    await Deno.mkdir(`${repoRoot}/sub`);
    await Deno.writeTextFile(`${repoRoot}/sub/a.txt`, "one\n");
    await git("add", "-A");
    await git("commit", "--quiet", "-m", "first");
    await Deno.writeTextFile(`${repoRoot}/sub/a.txt`, "two\n");
    await git("commit", "--quiet", "-a", "-m", "second");

    const result = await sweepGitRunnerFor(repoRoot)([
      "diff",
      "--name-only",
      "--diff-filter=M",
      "HEAD~1",
      "HEAD",
      "--",
      "sub",
    ]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(result.stdout.trim(), "sub/a.txt");
  } finally {
    await Deno.remove(repoRoot, { recursive: true });
  }
});

Deno.test("sweepGitRunnerFor - a spawn failure is reported, never swallowed (Issue #2178)", async () => {
  // The `!result.ok` branch is the only route by which a timeout or a spawn
  // failure reaches driftSince's loud SweepLedgerError. A directory that does
  // not exist makes the spawn throw, which runGitCommand reports as a failed
  // Result rather than a git exit code.
  const result = await sweepGitRunnerFor("/nonexistent-sweep-drift-repo")([
    "diff",
    "--name-only",
    "HEAD",
  ]);
  assertEquals(result.code, 1);
  assertEquals(result.stdout, "");
  assert(result.stderr.length > 0, "the spawn failure must carry a reason");
});

/** A throwaway checkout holding only the ledger and its one module. */
async function ledgerCheckout(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "sweep-drift-ancestry-" });
  await Deno.mkdir(`${dir}/docs/audits`, { recursive: true });
  await Deno.mkdir(`${dir}/worker/deno/lib`, { recursive: true });
  await Deno.writeTextFile(`${dir}/worker/deno/lib/a.ts`, "export {};\n");
  await Deno.writeTextFile(
    `${dir}/docs/audits/lib-sweep-coverage.json`,
    JSON.stringify(ledger()),
  );
  return dir;
}

function ancestryRunner(onDefault: boolean) {
  const calls: string[] = [];
  const runGit = (args: readonly string[]) => {
    calls.push(args.join(" "));
    if (args[0] === "merge-base") {
      return Promise.resolve({
        code: onDefault ? 0 : 1,
        stdout: "",
        stderr: "",
      });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  return { runGit, calls };
}

/**
 * The ledger checkout plus one top-up file in {@link LIB_SWEEP_TOP_UP_DIR},
 * whose slice records {@link TOP_UP_COMMIT} and owns a second module.
 */
async function ledgerCheckoutWithTopUp(): Promise<string> {
  const dir = await ledgerCheckout();
  await Deno.mkdir(`${dir}/${LIB_SWEEP_TOP_UP_DIR}`, { recursive: true });
  await Deno.writeTextFile(`${dir}/worker/deno/lib/b.ts`, "export {};\n");
  await Deno.writeTextFile(
    `${dir}/${LIB_SWEEP_TOP_UP_DIR}/${topUpChunkId(TOP_UP_ISSUE)}.json`,
    JSON.stringify({
      issue: TOP_UP_ISSUE,
      chunk: topUpChunkId(TOP_UP_ISSUE),
      title: "top-up fixture",
      ledger: "docs/audits/b.md",
      definition: "fixture",
      status: "swept",
      sweptAt: TOP_UP_COMMIT,
      paths: ["worker/deno/lib/b.ts"],
    }),
  );
  return dir;
}

Deno.test("sweep-drift command - --default-branch fails on a sweptAt off that branch, naming the slice (Issue #2754)", async () => {
  const dir = await ledgerCheckout();
  try {
    const { runGit, calls } = ancestryRunner(false);
    const result = await sweepDriftCommand.execute(
      { repo: dir, "default-branch": "origin/main", runGit },
      {} as never,
    );
    assertEquals(result.success, false);
    assert(result.message?.includes("slice 12a (#1214)"), result.message);
    assert(result.message?.includes(COMMIT), result.message);
    // The drift report never ran over a ledger that failed the guard.
    assert(!calls.some((call) => call.startsWith("diff ")), calls.join("\n"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sweep-drift command - --default-branch passes a ledger on that branch, then reports drift (Issue #2754)", async () => {
  const dir = await ledgerCheckout();
  try {
    const { runGit, calls } = ancestryRunner(true);
    const result = await sweepDriftCommand.execute(
      { repo: dir, "default-branch": "origin/main", runGit },
      {} as never,
    );
    assertEquals(result.success, true, result.message);
    assert(
      calls.includes(`merge-base --is-ancestor ${COMMIT} origin/main`),
      calls.join("\n"),
    );
    assert(calls.some((call) => call.startsWith("diff ")), calls.join("\n"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sweep-drift command - --default-branch checks a top-up file's sweptAt, naming its slice (#3203 review)", async () => {
  // Fail direction: CI's sweptAt-ancestry step runs this command, and every
  // new slice now lives in a top-up file. Were the command to read only the
  // ledger file, a top-up slice recording its feature branch's HEAD — a commit
  // squash-merge deletes — would pass CI unchecked (Issue #2754). Only the
  // top-up slice's commit is off the default branch, so the ledger file's
  // slice alone can never make this fail.
  const dir = await ledgerCheckoutWithTopUp();
  try {
    const calls: string[] = [];
    const runGit = (args: readonly string[]) => {
      calls.push(args.join(" "));
      const offDefault = args[0] === "merge-base" &&
        args[2] === TOP_UP_COMMIT;
      return Promise.resolve({
        code: offDefault ? 1 : 0,
        stdout: "",
        stderr: "",
      });
    };
    const result = await sweepDriftCommand.execute(
      { repo: dir, "default-branch": "origin/main", runGit },
      {} as never,
    );
    assertEquals(result.success, false, result.message);
    assert(
      result.message?.includes(
        `slice ${topUpChunkId(TOP_UP_ISSUE)} (#${TOP_UP_ISSUE})`,
      ),
      result.message,
    );
    assert(result.message?.includes(TOP_UP_COMMIT), result.message);
    // The ledger file's slice was on the branch, so it is not blamed.
    assert(!result.message?.includes("slice 12a"), result.message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sweep-drift producer uses the default merge-base and preserves it through squash and later main changes (Issue #3976)", async () => {
  const f = await setupGitRepoFixture("sweep-producer-");
  try {
    await gitOk(["config", "commit.gpgsign", "false"], f.clone);
    await Deno.mkdir(`${f.clone}/worker/deno/lib`, { recursive: true });
    const swept = await commitFile(
      f.clone,
      "worker/deno/lib/a.ts",
      "export {};\n",
      "base module",
    );
    await Deno.mkdir(`${f.clone}/docs/audits`, { recursive: true });
    const baseLedger = {
      ...ledger(),
      slices: [{ ...ledger().slices[0]!, sweptAt: swept }],
    };
    await commitFile(
      f.clone,
      "docs/audits/lib-sweep-coverage.json",
      JSON.stringify(baseLedger),
      "base ledger",
    );
    await gitOk(["push", "origin", "main"], f.clone);
    const base = (await gitOk(["rev-parse", "HEAD"], f.clone)).trim();
    await gitOk(["checkout", "-b", "feature"], f.clone);
    const feature = await commitFile(
      f.clone,
      "worker/deno/lib/b.ts",
      "export const added = true;\n",
      "feature module",
    );
    const payload = {
      issue: 4000,
      title: "new module",
      ledger: "docs/audits/read.md",
      definition: "new source module",
      status: "claimed",
      paths: ["worker/deno/lib/b.ts"],
    };
    const runGit = (args: readonly string[]) => git([...args], f.clone);
    await assertRejects(
      () =>
        verifySweptAtsOnDefaultBranch(
          {
            ...baseLedger,
            slices: [{
              ...payload,
              chunk: topUpChunkId(payload.issue),
              sweptAt: feature,
              status: "claimed",
            }],
          },
          "origin/main",
          runGit,
        ),
      Error,
      "not on origin/main",
    );
    const input = `${f.root}/input.json`;
    await Deno.writeTextFile(input, JSON.stringify(payload));
    const args = { repo: f.clone, "record-top-up": input };
    const outputDir = `${f.clone}/${LIB_SWEEP_TOP_UP_DIR}`;
    const outside = `${f.root}/outside-records`;
    await Deno.mkdir(outside);
    await Deno.symlink(outside, outputDir, { type: "dir" });
    const escaped = await sweepDriftCommand.execute(args, {} as never);
    assertEquals(escaped.success, false);
    assert(
      escaped.message.includes("top-up output escapes the repository"),
      escaped.message,
    );
    assertEquals(
      Array.from(await Array.fromAsync(Deno.readDir(outside))).length,
      0,
    );
    await Deno.remove(outputDir);
    if (Deno.build.os !== "windows") {
      await Deno.mkdir(outputDir);
      await Deno.chmod(outputDir, 0o500);
      try {
        const unavailable = await sweepDriftCommand.execute(args, {} as never);
        assertEquals(unavailable.success, false);
        assert(
          unavailable.message.includes(
            "atomicWrite — failed to create temp file",
          ),
          unavailable.message,
        );
      } finally {
        await Deno.chmod(outputDir, 0o700);
      }
    }
    const result = await sweepDriftCommand.execute(args, {} as never);
    assertEquals(result.success, true, result.message);
    const recordPath = `${LIB_SWEEP_TOP_UP_DIR}/${
      topUpChunkId(payload.issue)
    }.json`;
    let original = await Deno.readTextFile(`${f.clone}/${recordPath}`);
    assertEquals(JSON.parse(original).sweptAt, base);
    assertEquals(
      (await sweepDriftCommand.execute(args, {} as never)).success,
      true,
    );
    assertEquals(await Deno.readTextFile(`${f.clone}/${recordPath}`), original);
    // Finalising a claimed read changes only status, never its coverage horizon.
    await Deno.writeTextFile(
      input,
      JSON.stringify({ ...payload, status: "swept" }),
    );
    assertEquals(
      (await sweepDriftCommand.execute(args, {} as never)).success,
      true,
    );
    const finished = await Deno.readTextFile(`${f.clone}/${recordPath}`);
    assertEquals(JSON.parse(finished), {
      ...JSON.parse(original),
      status: "swept",
    });
    original = finished;
    if (Deno.build.os !== "windows") {
      await Deno.chmod(outputDir, 0o500);
      try {
        const repeat = await sweepDriftCommand.execute({
          ...args,
          "default-branch": "origin/main",
        }, {} as never);
        assertEquals(
          repeat.success,
          true,
          "an unchanged record requires no coverage-file write",
        );
      } finally {
        await Deno.chmod(outputDir, 0o700);
      }
    }
    // The finished payload above is the accepted paired control. Refusals
    // must identify their own rule instead of passing due to a later guard.
    for (
      const [invalid, rule] of [
        [
          { ...payload, status: "swept", definition: "different scope" },
          "existing top-up coverage is immutable",
        ],
        [
          { ...payload, status: "swept", paths: ["worker/deno/lib/a.ts"] },
          "existing top-up coverage is immutable",
        ],
        [payload, "existing top-up coverage is immutable"],
        [
          { ...payload, status: "swept", sweptAt: feature },
          "the producer owns chunk and sweptAt",
        ],
        [
          { ...payload, status: "swept", chunk: "invented" },
          "the producer owns chunk and sweptAt",
        ],
        [null, "top-up payload must be an object"],
        [[], "top-up payload must be an object"],
        ["not a record", "top-up payload must be an object"],
        [
          { ...payload, issue: 3200 },
          "new top-up issue must be a safe integer after 3200",
        ],
        [
          { ...payload, issue: 4000.5 },
          "new top-up issue must be a safe integer after 3200",
        ],
        [
          { ...payload, issue: Number.MAX_SAFE_INTEGER + 1 },
          "new top-up issue must be a safe integer after 3200",
        ],
        [
          { ...payload, issue: 4002, title: "" },
          '"slices[0].title" must be a non-empty string',
        ],
        [
          { ...payload, issue: 4002, status: "unknown" },
          'slices[0].status must be "swept" or "claimed"',
        ],
        [
          { ...payload, issue: 4002, paths: ["outside.ts"] },
          "top-up path is outside the ledger roots: outside.ts",
        ],
        [
          { ...payload, issue: 4002, paths: ["worker/deno/lib/../lib/b.ts"] },
          "top-up path is outside the ledger roots: worker/deno/lib/../lib/b.ts",
        ],
        [
          { ...payload, issue: 4002, paths: ["worker/deno/lib/./b.ts"] },
          "top-up path is outside the ledger roots: worker/deno/lib/./b.ts",
        ],
        [
          { ...payload, issue: 4002, paths: ["worker/deno/lib//b.ts"] },
          "top-up path is outside the ledger roots: worker/deno/lib//b.ts",
        ],
        [
          { ...payload, issue: 4002, paths: ["/worker/deno/lib/b.ts"] },
          "top-up path is outside the ledger roots: /worker/deno/lib/b.ts",
        ],
        [{
          ...payload,
          issue: 4002,
          paths: ["worker/deno/lib/b.ts", "worker/deno/lib/b.ts"],
        }, "top-up paths must be unique"],
      ] as const
    ) {
      await Deno.writeTextFile(input, JSON.stringify(invalid));
      const refused = await sweepDriftCommand.execute(args, {} as never);
      assertEquals(refused.success, false, JSON.stringify(invalid));
      assert(
        refused.message.includes(rule),
        `${JSON.stringify(invalid)}: ${refused.message}`,
      );
      assertEquals(
        await Deno.readTextFile(`${f.clone}/${recordPath}`),
        original,
      );
    }
    await Deno.writeTextFile(
      input,
      JSON.stringify({ ...payload, status: "swept" }),
    );
    const wrongDefault = await sweepDriftCommand.execute({
      ...args,
      "default-branch": "origin/feature",
    }, {} as never);
    assertEquals(wrongDefault.success, false);
    assert(
      wrongDefault.message.includes("differs from actual origin/main"),
      wrongDefault.message,
    );
    assertEquals(await Deno.readTextFile(`${f.clone}/${recordPath}`), original);
    // A ledger root can itself be the audited path, as well as containing
    // audited descendants. Both supported ownership shapes must serialize.
    await Deno.writeTextFile(
      input,
      JSON.stringify({ ...payload, issue: 4003, paths: ["worker/deno/lib"] }),
    );
    const exactRoot = await sweepDriftCommand.execute(args, {} as never);
    assertEquals(exactRoot.success, true, exactRoot.message);
    const exactRootPath = `${f.clone}/${LIB_SWEEP_TOP_UP_DIR}/top-up-4003.json`;
    assertEquals(JSON.parse(await Deno.readTextFile(exactRootPath)).paths, [
      "worker/deno/lib",
    ]);
    await Deno.remove(exactRootPath);
    await Deno.writeTextFile(
      input,
      JSON.stringify({ ...payload, status: "swept" }),
    );
    // A historical branch-only record must remain visibly invalid, never be
    // silently replaced with today's merge-base by regeneration.
    const historicalPath =
      `${f.clone}/${LIB_SWEEP_TOP_UP_DIR}/top-up-4001.json`;
    const historical = JSON.stringify({
      ...payload,
      issue: 4001,
      chunk: "top-up-4001",
      sweptAt: feature,
    });
    await Deno.writeTextFile(historicalPath, historical);
    const historicalInput = `${f.root}/historical.json`;
    await Deno.writeTextFile(
      historicalInput,
      JSON.stringify({ ...payload, issue: 4001 }),
    );
    const refused = await sweepDriftCommand.execute({
      ...args,
      "record-top-up": historicalInput,
    }, {} as never);
    assertEquals(refused.success, false);
    assert(refused.message.includes("not on origin/main"), refused.message);
    assertEquals(await Deno.readTextFile(historicalPath), historical);
    await Deno.remove(historicalPath);
    await gitOk(["add", recordPath], f.clone);
    await gitOk(["commit", "-m", "record top-up"], f.clone);
    await gitOk(["checkout", "main"], f.clone);
    await gitOk(["merge", "--squash", "feature"], f.clone);
    await gitOk(["commit", "-m", "squash feature"], f.clone);
    await commitFile(
      f.clone,
      "README.md",
      "later default change\n",
      "advance default",
    );
    await gitOk(["push", "origin", "main"], f.clone);
    await verifySweptAtsOnDefaultBranch(
      await readCoverageLedger(f.clone),
      "origin/main",
      runGit,
    );
    assertEquals(
      (await sweepDriftCommand.execute(args, {} as never)).success,
      true,
    );
    assertEquals(await Deno.readTextFile(`${f.clone}/${recordPath}`), original);
  } finally {
    await f.cleanup();
  }
});

Deno.test("sweep-drift producer leaves unavailable refs and invalid input visible without a record (Issue #3976)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sweep-unavailable-" });
  try {
    const input = `${dir}/input.json`;
    const payload = {
      issue: 4000,
      title: "new module",
      ledger: "https://example.com/audit",
      definition: "new source",
      status: "claimed",
      paths: ["worker/deno/lib/b.ts"],
    };
    await Deno.writeTextFile(input, JSON.stringify(payload));
    const runGit = () =>
      Promise.resolve({ code: 128, stdout: "", stderr: "remote unavailable" });
    for (
      const [args, rule] of [
        [{ repo: dir, "record-top-up": input, runGit }, "remote unavailable"],
        [{
          repo: dir,
          "record-top-up": input,
          runGit: () => Promise.reject("remote unavailable non-error"),
        }, "remote unavailable non-error"],
        [{
          repo: dir,
          "record-top-up": input,
          runGit: () => Promise.resolve({ code: 128, stdout: "", stderr: "" }),
        }, "git ls-remote failed: exit 128"],
        [
          { repo: dir, "record-top-up": "" },
          "--record-top-up requires a JSON payload path",
        ],
        [
          { repo: dir, "record-top-up": 42 },
          "--record-top-up requires a JSON payload path",
        ],
        [
          { repo: dir, "record-top-up": `${dir}/missing.json` },
          "cannot read payload",
        ],
      ] as const
    ) {
      const out = await sweepDriftCommand.execute(args, {} as never);
      assertEquals(out.success, false);
      assert(out.message.startsWith("Sweep record unavailable:"), out.message);
      assert(out.message.includes(rule), out.message);
      await assertRejects(
        () => Deno.stat(`${dir}/${LIB_SWEEP_TOP_UP_DIR}/top-up-4000.json`),
        Deno.errors.NotFound,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sweep-drift producer reports missing default, stale fetch and shallow history without writing coverage (Issue #3976)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sweep-history-unavailable-" });
  try {
    const input = `${dir}/input.json`;
    await Deno.writeTextFile(
      input,
      JSON.stringify({
        issue: 4000,
        title: "new module",
        ledger: "docs/audits/read.md",
        definition: "new source",
        status: "claimed",
        paths: ["worker/deno/lib/b.ts"],
      }),
    );
    for (
      const fault of [
        "default",
        "fetch",
        "history",
        "merge-base",
        "advertised-default",
        "wrong-head-target",
        "ambiguous-head",
        "bad-sha",
      ]
    ) {
      const runGit = (args: readonly string[]) => {
        if (args[0] === "ls-remote") {
          return Promise.resolve(
            fault === "default"
              ? { code: 128, stdout: "", stderr: "missing default ref" }
              : {
                code: 0,
                stdout: fault === "advertised-default"
                  ? "not a symref\n"
                  : fault === "wrong-head-target"
                  ? "ref: refs/heads/main\tOTHER\n"
                  : fault === "ambiguous-head"
                  ? "ref: refs/heads/main\tHEAD\nref: refs/heads/other\tHEAD\n"
                  : "ref: refs/heads/main\tHEAD\n",
                stderr: "",
              },
          );
        }
        if (args[0] === "fetch") {
          return Promise.resolve(
            fault === "fetch" ||
              args.some((a) => a.startsWith("--deepen") || a === "--unshallow")
              ? { code: 128, stdout: "", stderr: "network unavailable" }
              : { code: 0, stdout: "", stderr: "" },
          );
        }
        if (args[0] === "rev-parse" && args[1] === "--is-shallow-repository") {
          return Promise.resolve({
            code: 0,
            stdout: fault === "history" ? "true\n" : "false\n",
            stderr: "",
          });
        }
        if (fault === "bad-sha" && args[0] === "merge-base") {
          return Promise.resolve({ code: 0, stdout: "abc\n", stderr: "" });
        }
        return Promise.resolve({
          code: 128,
          stdout: "",
          stderr: "missing common history",
        });
      };
      const out = await sweepDriftCommand.execute({
        repo: dir,
        "record-top-up": input,
        runGit,
      }, {} as never);
      assertEquals(out.success, false, fault);
      assert(out.message.startsWith("Sweep record unavailable:"), out.message);
      assert(
        out.message.includes(
          fault === "default"
            ? "missing default ref"
            : fault === "fetch"
            ? "network unavailable"
            : fault === "history"
            ? "Failed to deepen repo"
            : ["advertised-default", "wrong-head-target", "ambiguous-head"]
                .includes(fault)
            ? "remote HEAD does not name exactly one default branch"
            : fault === "bad-sha"
            ? "default merge-base is not a full commit"
            : "missing common history",
        ),
        out.message,
      );
      await assertRejects(
        () => Deno.stat(`${dir}/${LIB_SWEEP_TOP_UP_DIR}/top-up-4000.json`),
        Deno.errors.NotFound,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sweep-drift producer bootstraps the actual default in a shallow feature-only clone (Issue #3976)", async () => {
  const f = await setupGitRepoFixture("sweep-narrow-");
  try {
    await Deno.mkdir(`${f.clone}/docs/audits`, { recursive: true });
    const baseLedger = {
      ...ledger(),
      slices: [{
        ...ledger().slices[0]!,
        sweptAt: (await gitOk(["rev-parse", "HEAD"], f.clone)).trim(),
      }],
    };
    const base = await commitFile(
      f.clone,
      "docs/audits/lib-sweep-coverage.json",
      JSON.stringify(baseLedger),
      "base ledger",
    );
    await gitOk(["push", "origin", "main"], f.clone);
    await gitOk(["checkout", "-b", "feature"], f.clone);
    await Deno.mkdir(`${f.clone}/worker/deno/lib`, { recursive: true });
    await commitFile(
      f.clone,
      "worker/deno/lib/b.ts",
      "export {};\n",
      "feature module",
    );
    await gitOk(["push", "origin", "feature"], f.clone);
    const narrow = `${f.root}/narrow`;
    await gitOk([
      "clone",
      "--depth=1",
      "--single-branch",
      "--branch",
      "feature",
      `file://${f.remote}`,
      narrow,
    ], f.root);
    assertEquals(
      (await git(["rev-parse", "--verify", "origin/main"], narrow)).code,
      128,
    );
    const input = `${f.root}/input.json`;
    await Deno.writeTextFile(
      input,
      JSON.stringify({
        issue: 4000,
        title: "new module",
        ledger: "docs/audits/read.md",
        definition: "new source",
        status: "claimed",
        paths: ["worker/deno/lib/b.ts"],
      }),
    );
    const result = await sweepDriftCommand.execute({
      repo: narrow,
      "record-top-up": input,
    }, {} as never);
    assertEquals(result.success, true, result.message);
    const record = JSON.parse(
      await Deno.readTextFile(
        `${narrow}/${LIB_SWEEP_TOP_UP_DIR}/top-up-4000.json`,
      ),
    );
    assertEquals(record.sweptAt, base);
    await verifySweptAtsOnDefaultBranch(
      await readCoverageLedger(narrow),
      "origin/main",
      sweepGitRunnerFor(narrow),
    );
  } finally {
    await f.cleanup();
  }
});

Deno.test("sweep-drift producer redacts remote error secrets at the command result sink (Issue #3976)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "sweep-redaction-" });
  try {
    const input = `${dir}/input.json`;
    const token = "ghp_" + "a".repeat(36);
    await Deno.writeTextFile(
      input,
      JSON.stringify({
        issue: 4000,
        title: "new module",
        ledger: "docs/audits/read.md",
        definition: "new source",
        status: "claimed",
        paths: [],
      }),
    );
    const runGit = () =>
      Promise.resolve({
        code: 128,
        stdout: "",
        stderr:
          `fatal: authentication failed https://${token}@github.com/example/repo`,
      });
    const out = await sweepDriftCommand.execute({
      repo: dir,
      "record-top-up": input,
      runGit,
    }, {} as never);
    assertEquals(out.success, false);
    assert(
      !out.message.includes(token),
      "unavailable command result must redact remote credentials",
    );
    assert(
      out.message.includes("authentication failed"),
      "retain the useful failure cause",
    );
    const missing = await sweepDriftCommand.execute({
      repo: dir,
      "record-top-up": `${dir}/${token}.json`,
    }, {} as never);
    assertEquals(missing.success, false);
    assert(missing.message.includes("cannot read payload"), missing.message);
    assert(
      !missing.message.includes(token),
      "payload-read errors must redact before the command result sink",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
