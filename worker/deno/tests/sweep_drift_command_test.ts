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

import { assert, assertEquals } from "@std/assert";
import {
  collectSweepDrift,
  formatSweepDriftReport,
  sweepDriftCommand,
  sweepGitRunnerFor,
} from "../commands/sweep_drift.ts";
import type { SweepCoverageLedger } from "../lib/lib_sweep_coverage.ts";

const COMMIT = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

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
