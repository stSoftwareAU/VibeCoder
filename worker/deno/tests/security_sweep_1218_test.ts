/**
 * Regression tests for the chunk-13 security sweep of `worker/deno/commands/`
 * (Issue #1218).
 *
 * Every test here drives the real command's `execute()` (or the real helper the
 * command dispatches into) with the attacking input the sweep named, and
 * asserts the refusal. Fail direction is stated on each block: each test goes
 * RED against the pre-fix code and GREEN after it.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { prManagerCommand } from "../commands/pr_manager.ts";
import { workerLogCleanupCommand } from "../commands/worker_log_cleanup.ts";
import { loadConfigCommand } from "../commands/load_config.ts";
import {
  _resetGhSpawnRunner,
  _setGhSpawnRunner,
  type GhSpawnResult,
} from "../lib/gh_spawn.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

function testConfig(): WorkerConfig {
  return buildDefaultWorkerConfig({
    allowedAuthors: ["testuser"],
    allowedAuthor: "testuser",
    prReviewer: "reviewer",
    repos: ["owner/repo"],
    issueLabels: ["claude"],
    authorisedCommenters: ["testuser"],
    workDir: "/tmp/work",
  }) as WorkerConfig;
}

function ok(stdout: string): GhSpawnResult {
  return { code: 0, success: true, stdout, stderr: "" };
}

// =============================================================================
// SEC-1218-02 — `pr-manager --operation finalise-pr` must not hand-roll a
// direct merge around `directMergePr()`.
//
// Pre-fix, the `NotAllowed` arm issued a raw `gh pr merge <n> --repo <r>
// --squash`, skipping the default-branch human-approval guard (#2416/#1082),
// the CI-green/branch-current backstop (#2582) and the head-SHA pin (#3946).
// Fail direction: this test goes RED against that code (the ungated merge argv
// is recorded and the command reports success) and GREEN once the arm routes
// through the chokepoint, where a default-branch target is refused.
// =============================================================================

Deno.test("prManagerCommand - finalise-pr refuses an ungated direct merge onto the default branch", async () => {
  const calls: string[][] = [];
  _setGhSpawnRunner((args) => {
    const argv = [...args];
    calls.push(argv);
    const joined = argv.join(" ");

    // fetchHeadRefName — an ordinary issue branch, so no milestone gate fires.
    if (joined.includes("--json headRefName")) {
      return Promise.resolve(ok("issue-42-fix\n"));
    }
    // The PR targets `main`, which is both protected and the repository's
    // default branch. Protected means `enableAutoMerge` arms `--auto` rather
    // than taking its own gated-merge branch; default means `directMergePr`
    // must refuse when the `NotAllowed` arm reaches it.
    if (joined.includes("baseRefName")) {
      return Promise.resolve(ok("main\n"));
    }
    if (joined.includes("rules/branches/")) {
      return Promise.resolve(ok("required_status_checks\n"));
    }
    if (joined.includes("--jq .default_branch")) {
      return Promise.resolve(ok("main\n"));
    }
    // The auto-merge attempt is refused the way an unprotected base refuses
    // it, which is what drives the command into the NotAllowed arm.
    if (argv[0] === "pr" && argv[1] === "merge" && argv.includes("--auto")) {
      return Promise.reject(
        new Error(
          "Pull request Auto merge is not allowed for this repository",
        ),
      );
    }
    return Promise.resolve(ok(""));
  });

  try {
    const result = await prManagerCommand.execute(
      {
        operation: "finalise-pr",
        repo: "owner/repo",
        "pr-number": 42,
      },
      testConfig(),
    );

    // No un-gated merge may ever be issued: every `pr merge` argv that the
    // runner saw must be the `--auto` arming call, never a bare direct merge.
    const bareMerges = calls.filter((argv) =>
      argv[0] === "pr" && argv[1] === "merge" && !argv.includes("--auto")
    );
    assertEquals(bareMerges, []);
    // And the refusal is loud, not a "direct merge attempted" success.
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "refused");
  } finally {
    _resetGhSpawnRunner();
  }
});

// =============================================================================
// SEC-1218-03 — `process-add-repo`'s default runner must delegate `gh` to the
// shared chokepoint.
//
// Pre-fix it spawned `new Deno.Command(cmd[0]!, …)` with `cmd[0] === "gh"`, so
// the label writes made on behalf of a requester-named repository skipped
// `enforceGhWriteAllowlist`, `redactGhBodyArgs` and `auditGhMutation`, and the
// literal-only build check could not see it. Fail direction: RED pre-fix
// (nothing reaches the stubbed chokepoint runner because a real `gh` is
// spawned), GREEN once `cmd[0] === "gh"` is delegated to `spawnGh`.
// =============================================================================

Deno.test("processAddRepoCommand - the default runner sends gh through the spawnGh chokepoint", async () => {
  const { defaultRunCommand } = await import(
    "../commands/process_add_repo.ts"
  );
  const seen: string[][] = [];
  _setGhSpawnRunner((args) => {
    seen.push([...args]);
    return Promise.resolve(ok("{}"));
  });

  try {
    const result = await defaultRunCommand([
      "gh",
      "api",
      "repos/evil/target",
    ]);
    assertEquals(result.success, true);
    // The argv reached the chokepoint with the binary name already stripped.
    assertEquals(seen, [["api", "repos/evil/target"]]);
  } finally {
    _resetGhSpawnRunner();
  }
});

// =============================================================================
// SEC-1218-04 — `worker-log-cleanup`'s foreign-file sweep must delete only
// worker debris.
//
// Pre-fix it removed EVERY unrecognised plain file older than 14 days in the
// configured log directory, and `log_dir: "~"` is an accepted configuration
// that resolves that directory to the operator's `$HOME`. Fail direction: RED
// pre-fix (`.bash_history` and `notes.txt` are unlinked), GREEN once the sweep
// matches an explicit debris allowlist.
// =============================================================================

Deno.test("workerLogCleanupCommand - leaves unrelated old files in the log directory alone", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-1218-logs-" });
  const old = new Date(Date.now() - 60 * 24 * 60 * 60_000);
  try {
    const write = async (name: string, body: string) => {
      const path = `${dir}/${name}`;
      await Deno.writeTextFile(path, body);
      await Deno.utime(path, old, old);
    };
    // Files a home directory would hold — none of them the worker's business.
    await write(".bash_history", "ls -la\n");
    await write("notes.txt", "personal notes\n");
    await write("tax-return.pdf", "%PDF-1.4\n");
    // Genuine debris from a long-gone native run — the Issue #4306 case.
    await write("node-17422.log", "old native run\n");
    await write("stage-build.state", "done\n");

    const result = await workerLogCleanupCommand.execute(
      { "log-dir": dir },
      testConfig(),
    );

    assertEquals(result.success, true);
    for (const kept of [".bash_history", "notes.txt", "tax-return.pdf"]) {
      assertEquals(
        (await Deno.stat(`${dir}/${kept}`)).isFile,
        true,
        `${kept} must survive the sweep`,
      );
    }
    const foreign =
      (result.data as { foreignDeleted?: string[] } | undefined)
        ?.foreignDeleted ?? [];
    assertEquals(foreign.length, 2);
    assertEquals(
      foreign.every((p: string) =>
        p.endsWith("node-17422.log") || p.endsWith("stage-build.state")
      ),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isForeignDebrisName - names worker debris only", async () => {
  const { isForeignDebrisName } = await import(
    "../lib/worker_log_cleanup.ts"
  );
  for (const debris of [
    "node-17422.log",
    "node-17422.log.gz",
    "stage-build.state",
    "launch-2026-01-01.log",
    "worker-99.log.3",
    "agent-vibe-abc.jsonl.1",
  ]) {
    assertEquals(isForeignDebrisName(debris), true, debris);
  }
  for (const keep of [
    ".bash_history",
    ".gitconfig",
    ".netrc",
    "notes.txt",
    "postgres.log",
    "id_rsa",
    "backup.tar.gz",
  ]) {
    assertEquals(isForeignDebrisName(keep), false, keep);
  }
});

// =============================================================================
// SEC-1218-05 — `load-config` must never emit an unescapable shell variable
// NAME into output that is `eval`'d.
//
// A `phase_model_overrides` key is copied verbatim from `.config.json` into
// `CLAUDE_MODEL_${phase.toUpperCase()}`, and only the VALUE was escaped. Fail
// direction: RED pre-fix (the command emits
// `export CLAUDE_MODEL_PLAN; PATH=/tmp/evil; #="…"`, a second statement that
// runs under `eval`), GREEN once a non-identifier name is refused outright.
// =============================================================================

Deno.test("isSafeShellIdentifier - accepts identifiers and refuses injection shapes", async () => {
  const { isSafeShellIdentifier } = await import("../commands/load_config.ts");
  for (const good of ["PLAN", "CLAUDE_MODEL_PLAN", "_x9"]) {
    assertEquals(isSafeShellIdentifier(good), true, good);
  }
  for (const bad of [
    "PLAN; PATH=/TMP/EVIL; #",
    "PLAN`id`",
    "PLAN$(id)",
    "PLAN PLAN",
    "9PLAN",
    "",
  ]) {
    assertEquals(isSafeShellIdentifier(bad), false, bad);
  }
});

Deno.test("loadConfigCommand - refuses a phase override key that is not a shell identifier", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-1218-config-" });
  const path = `${dir}/.config.json`;
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        allowed_authors: ["testuser"],
        repos: ["owner/repo"],
        issue_labels: ["claude"],
        work_dir: "/tmp/work",
        pr_reviewer: "reviewer",
        phase_model_overrides: { "PLAN; PATH=/tmp/evil; #": "sonnet" },
      }),
    );

    // The command must fail loudly rather than emit a line that `eval` would
    // split into two statements.
    const error = await assertRejects(
      () => loadConfigCommand.execute({ "config-path": path }, testConfig()),
      Error,
    );
    assertStringIncludes(error.message, "Refusing to emit shell variable");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
