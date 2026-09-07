/**
 * Tests for write_repo_allowlist.ts — the per-run write-repo allowlist that
 * contains egress by refusing any GitHub write to a repo not on the current
 * run's allowlist (Issue #3311, workstream 1 of #3309).
 *
 * These WHAT-tests drive the exported functions and assert on their
 * observable effect — a write is allowed or refused, an audit event and a
 * security log line are emitted on a block — never on internal call order,
 * so they survive a refactor of how the check is wired.
 *
 * The audit/log sinks are injected via `_setWriteRepoAllowlistSinks` so the
 * tests stay hermetic (no filesystem journal writes, no real console noise).
 * Every test resets the module state in a `finally` to avoid leaking into
 * siblings.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  _resetWriteRepoAllowlistSinks,
  _resetWriteRepoPins,
  _setWriteRepoAllowlistSinks,
  enforceGhWriteAllowlist,
  isWriteRepoAllowed,
  isWriteRepoAllowlistActive,
  listAllowedWriteRepos,
  noteAgentAllowlistSnapshot,
  pinWriteRepo,
  registerWriteRepo,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
  unpinWriteRepo,
  withScopedWriteRepo,
  WriteRepoBlockedError,
} from "../lib/write_repo_allowlist.ts";
import type { AuditMutation } from "../lib/audit_journal.ts";
import { processSeedIdleTasksCommand } from "../commands/process_seed_idle_tasks.ts";
import type { Logger, WorkerConfig } from "../types.ts";

/** Silent logger for the sweep cases (Issue #3860). */
function allowlistTestLogger(): Logger {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

/** Install capturing sinks; returns the captured audit + log arrays. */
function captureSinks(): { audits: AuditMutation[]; logs: string[] } {
  const audits: AuditMutation[] = [];
  const logs: string[] = [];
  _setWriteRepoAllowlistSinks({
    record: (m) => {
      audits.push(m);
      return Promise.resolve({ ok: true, value: undefined as never });
    },
    log: (m) => logs.push(m),
  });
  return { audits, logs };
}

/** Restore module state to inert defaults after each test. */
function cleanup(): void {
  resetWriteRepoAllowlist();
  _resetWriteRepoPins();
  _resetWriteRepoAllowlistSinks();
}

Deno.test("write-repo-allowlist - inactive by default: everything allowed (fail-open)", () => {
  try {
    assertEquals(isWriteRepoAllowlistActive(), false);
    assertEquals(isWriteRepoAllowed("any/repo"), true);
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - (a) write to target repo is allowed", async () => {
  try {
    captureSinks();
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    assert(isWriteRepoAllowlistActive());
    assert(isWriteRepoAllowed("stSoftwareAU/VibeCoder"));
    // A gh mutation explicitly targeting the run's own repo must pass.
    await enforceGhWriteAllowlist([
      "issue",
      "comment",
      "42",
      "-R",
      "stSoftwareAU/VibeCoder",
      "--body",
      "hi",
    ]);
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - (b) write to off-allowlist repo is blocked with audit + log", async () => {
  try {
    const { audits, logs } = captureSinks();
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");

    const err = await assertRejects(
      () =>
        enforceGhWriteAllowlist([
          "issue",
          "comment",
          "7",
          "-R",
          "attacker/public-repo",
          "--body",
          "exfiltrated secrets",
        ]),
      WriteRepoBlockedError,
    );
    assertEquals(err.repo, "attacker/public-repo");

    // Security audit event recorded through the audit journal path.
    assertEquals(audits.length, 1);
    const audit = audits[0]!;
    assertEquals(audit.repo, "attacker/public-repo");
    assertEquals(audit.outcome, "error");
    // A single security-audit log line was emitted.
    assertEquals(logs.length, 1);
    const log = logs[0]!;
    assert(log.includes("attacker/public-repo"));
    assert(log.includes("[SECURITY]"));
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - (c) idle-scan scanned repo is allowed once seeded", async () => {
  try {
    captureSinks();
    // An idle-task run seeds the scanned repo (cwd = target clone).
    seedWriteRepoAllowlist("stSoftwareAU/private-repo-11");
    assert(isWriteRepoAllowed("stSoftwareAU/private-repo-11"));
    // Filing a finding issue in the scanned repo must pass.
    await enforceGhWriteAllowlist([
      "issue",
      "create",
      "-R",
      "stSoftwareAU/private-repo-11",
      "--title",
      "Finding",
      "--body",
      "b",
    ]);
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - (d) a second repo is writable only once explicitly registered", async () => {
  try {
    captureSinks();
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");

    // Before registration, a write to the second repo is blocked.
    assertEquals(isWriteRepoAllowed("stSoftwareAU/other-repo"), false);
    await assertRejects(
      () =>
        enforceGhWriteAllowlist([
          "pr",
          "create",
          "-R",
          "stSoftwareAU/other-repo",
          "--title",
          "Fix root cause",
        ]),
      WriteRepoBlockedError,
    );

    // A sanctioned worker-side flow registers the one extra repo explicitly.
    registerWriteRepo("stSoftwareAU/other-repo");
    assert(isWriteRepoAllowed("stSoftwareAU/other-repo"));
    await enforceGhWriteAllowlist([
      "pr",
      "create",
      "-R",
      "stSoftwareAU/other-repo",
      "--title",
      "Fix root cause",
    ]);
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - read-only gh commands are never blocked", async () => {
  try {
    captureSinks();
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    // Reads against another repo must pass — only writes are contained.
    await enforceGhWriteAllowlist([
      "issue",
      "view",
      "1",
      "-R",
      "attacker/public-repo",
    ]);
    await enforceGhWriteAllowlist([
      "api",
      "repos/attacker/public-repo/issues",
    ]);
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - cwd write with no explicit repo is allowed", async () => {
  try {
    captureSinks();
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    // No -R flag: gh targets the cwd repo (the run's own clone), so the
    // classifier yields no repo and the write is allowed.
    await enforceGhWriteAllowlist([
      "issue",
      "comment",
      "42",
      "--body",
      "in-repo comment",
    ]);
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - chokepoint covers comment, label, and api write paths", async () => {
  try {
    captureSinks();
    seedWriteRepoAllowlist("me/target");

    // The shared write path used by comment/label/PR/api operations is all
    // routed through the same classifier — each off-allowlist write blocks.
    const offAllowlistWrites: string[][] = [
      ["issue", "comment", "1", "-R", "other/repo", "--body", "x"],
      ["pr", "create", "-R", "other/repo", "--title", "x"],
      ["label", "create", "bug", "-R", "other/repo"],
      [
        "api",
        "-X",
        "POST",
        "repos/other/repo/issues/1/comments",
        "-f",
        "body=x",
      ],
    ];
    for (const args of offAllowlistWrites) {
      await assertRejects(
        () => enforceGhWriteAllowlist(args),
        WriteRepoBlockedError,
      );
    }
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - repo matching is case-insensitive", () => {
  try {
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    assert(isWriteRepoAllowed("stsoftwareau/vibecoder"));
    assert(isWriteRepoAllowed("STSOFTWAREAU/VIBECODER"));
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - seeding resets any previously allowed repos", () => {
  try {
    seedWriteRepoAllowlist("a/one");
    registerWriteRepo("b/two");
    assertEquals(listAllowedWriteRepos().sort(), ["a/one", "b/two"]);
    // A fresh run reseeds — the previous run's extra repos must not leak.
    seedWriteRepoAllowlist("c/three");
    assertEquals(listAllowedWriteRepos(), ["c/three"]);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Worker-only grants after the agent's shim snapshot (Issue #3861)
//
// `registerWriteRepo` widens the *worker's* boundary. The agent subprocess
// carries the allowlist baked into its `gh` wrapper at spawn time, so a grant
// made afterwards cannot reach it — that has to be loud, not silent.
// ---------------------------------------------------------------------------

Deno.test("write-repo-allowlist - a grant before the agent snapshot is silent (Issue #3861)", () => {
  try {
    const { logs } = captureSinks();
    seedWriteRepoAllowlist("a/target");
    registerWriteRepo("b/extra");
    assert(isWriteRepoAllowed("b/extra"));
    assertEquals(logs, [], "a pre-spawn grant is the supported case");
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - a grant after the agent snapshot warns loudly (Issue #3861)", () => {
  try {
    const { logs } = captureSinks();
    seedWriteRepoAllowlist("a/target");
    noteAgentAllowlistSnapshot();

    registerWriteRepo("b/extra");

    // The worker-side grant still takes effect …
    assert(isWriteRepoAllowed("b/extra"));
    // … but it is reported, because the running agent cannot see it.
    assertEquals(logs.length, 1);
    assertStringIncludes(logs[0] ?? "", "WRITE_REPO_GRANT_AFTER_SPAWN");
    assertStringIncludes(logs[0] ?? "", "b/extra");
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - re-registering an already-allowed repo after the snapshot is silent (Issue #3861)", () => {
  try {
    const { logs } = captureSinks();
    seedWriteRepoAllowlist("a/target");
    noteAgentAllowlistSnapshot();

    // No widening happens, so there is nothing the agent is missing.
    registerWriteRepo("A/Target");
    assertEquals(logs, []);
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - a reseed clears the agent snapshot state (Issue #3861)", () => {
  try {
    const { logs } = captureSinks();
    seedWriteRepoAllowlist("a/target");
    noteAgentAllowlistSnapshot();

    // The next claim spawns its own agent, which bakes the fresh allowlist.
    seedWriteRepoAllowlist("c/next");
    registerWriteRepo("d/extra");
    assertEquals(logs, []);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Pinned repos (Issue #3760) — long-lived background writers (heartbeats)
// pin their claim's repo so a reseed for the next claim cannot block their
// marker refreshes mid-flight.
// ---------------------------------------------------------------------------

Deno.test("write-repo-allowlist - pinned repo survives a reseed (Issue #3760)", async () => {
  try {
    captureSinks();
    // A heartbeat for the previous claim pins its repo...
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    pinWriteRepo("stSoftwareAU/VibeCoder");
    // ...then the next claim reseeds with a different target repo.
    seedWriteRepoAllowlist("stsoftwareau/private-repo-18");

    // The seeded set was replaced, but the pinned repo must stay writable —
    // this is exactly the heartbeat marker PATCH that used to be refused.
    assert(isWriteRepoAllowed("stSoftwareAU/VibeCoder"));
    await enforceGhWriteAllowlist([
      "api",
      "-X",
      "PATCH",
      "repos/stSoftwareAU/VibeCoder/issues/comments/1",
      "-f",
      "body=heartbeat",
    ]);
    // An unpinned third repo is still blocked — pinning does not fail open.
    await assertRejects(
      () =>
        enforceGhWriteAllowlist([
          "issue",
          "comment",
          "1",
          "-R",
          "attacker/public-repo",
          "--body",
          "x",
        ]),
      WriteRepoBlockedError,
    );
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - unpin removes protection once refcount drains", () => {
  try {
    seedWriteRepoAllowlist("a/target");
    // Two independent heartbeats on the same repo pin it twice.
    pinWriteRepo("b/pinned");
    pinWriteRepo("b/pinned");

    unpinWriteRepo("b/pinned");
    assert(
      isWriteRepoAllowed("b/pinned"),
      "repo must stay pinned while another heartbeat still holds it",
    );

    unpinWriteRepo("b/pinned");
    assertEquals(
      isWriteRepoAllowed("b/pinned"),
      false,
      "repo must lose protection when the last pin is released",
    );
    // Unpinning a repo that was never pinned is a safe no-op.
    unpinWriteRepo("never/pinned");
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - pins survive resetWriteRepoAllowlist between runs", () => {
  try {
    // A leaked heartbeat's pin must span the end-of-run reset → next-claim
    // seed sequence, otherwise the reseed re-introduces the block.
    seedWriteRepoAllowlist("a/one");
    pinWriteRepo("stSoftwareAU/VibeCoder");
    resetWriteRepoAllowlist();
    seedWriteRepoAllowlist("c/three");
    assert(isWriteRepoAllowed("stSoftwareAU/VibeCoder"));
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - pin matching is case-insensitive", () => {
  try {
    seedWriteRepoAllowlist("a/target");
    pinWriteRepo("stSoftwareAU/VibeCoder");
    assert(isWriteRepoAllowed("stsoftwareau/vibecoder"));
    unpinWriteRepo("STSOFTWAREAU/VIBECODER");
    assertEquals(isWriteRepoAllowed("stsoftwareau/vibecoder"), false);
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - enforcement is inert when not seeded", async () => {
  try {
    const { audits, logs } = captureSinks();
    // No seed: even an explicit cross-repo write is allowed (fail-open) so
    // unrelated flows and tests are unaffected until a run opts in.
    await enforceGhWriteAllowlist([
      "issue",
      "comment",
      "1",
      "-R",
      "other/repo",
      "--body",
      "x",
    ]);
    assertEquals(audits.length, 0);
    assertEquals(logs.length, 0);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Worker-side idle-task seeding sweep (Issue #3860)
//
// A `seed-idle-tasks: owner/repo` issue is handled by the worker, not the
// agent, so the worker must register the target on this run's allowlist
// before the seeding helper runs. Case (a) below is the tripwire for the
// #3858 failure mode (the target was never registered, so the very first
// `gh issue create` was refused); case (b) is the tripwire for the opposite,
// dangerous direction (the check widens and an off-config repo is granted).
// ---------------------------------------------------------------------------

Deno.test("write-repo-allowlist - (a) sweep registers the target before seeding", async () => {
  try {
    captureSinks();
    const enforcedDuringSeeding: string[] = [];

    const result = await processSeedIdleTasksCommand.execute(
      {
        "repo": "stSoftwareAU/VibeCoder",
        "issue-number": 3858,
        "title": "seed-idle-tasks: stSoftwareAU/private-repo-14",
        "__testDeps": {
          runGhCommand: () => Promise.resolve(""),
          logger: allowlistTestLogger(),
          // Runs at the exact point the real helper would issue its first
          // `gh issue create` against the target.
          createWrappersFn: async (repo: string) => {
            await enforceGhWriteAllowlist([
              "issue",
              "create",
              "--repo",
              repo,
              "--title",
              "wrapper",
              "--body",
              "x",
            ]);
            enforcedDuringSeeding.push(repo);
            return { ok: true, value: { created: ["dead-code"], skipped: [] } };
          },
        },
      },
      {
        repos: ["stSoftwareAU/VibeCoder", "stSoftwareAU/private-repo-14"],
      } as unknown as WorkerConfig,
    );

    assertEquals(result.success, true);
    assertEquals(
      enforcedDuringSeeding,
      ["stSoftwareAU/private-repo-14"],
      "the target must be writable when the seeding helper runs",
    );
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - (b) off-config sweep target is refused, allowlist untouched", async () => {
  try {
    captureSinks();
    let seedCalls = 0;

    const result = await processSeedIdleTasksCommand.execute(
      {
        "repo": "stSoftwareAU/VibeCoder",
        "issue-number": 4242,
        "title": "seed-idle-tasks: attacker/exfil",
        "__testDeps": {
          runGhCommand: () => Promise.resolve(""),
          logger: allowlistTestLogger(),
          createWrappersFn: () => {
            seedCalls++;
            return Promise.resolve({
              ok: true,
              value: { created: [], skipped: [] },
            });
          },
        },
      },
      {
        repos: ["stSoftwareAU/VibeCoder", "stSoftwareAU/private-repo-14"],
      } as unknown as WorkerConfig,
    );

    assertEquals(
      (result.data as { outcome?: string } | undefined)?.outcome,
      "not_monitored",
    );
    assertEquals(seedCalls, 0);
    assertEquals(isWriteRepoAllowlistActive(), false);
    assertEquals(
      listAllowedWriteRepos(),
      [],
      "a refused target must never be added to the allowlist",
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// withScopedWriteRepo — the fourth extension point (Issue #182)
// ---------------------------------------------------------------------------

Deno.test("write-repo-allowlist - a scoped grant opens the boundary only for the wrapped call", async () => {
  try {
    const { logs } = captureSinks();
    seedWriteRepoAllowlist("stSoftwareAU/GRQ");
    assertEquals(isWriteRepoAllowed("stSoftwareAU/NEAT-AI-Discovery"), false);

    let allowedInside = false;
    await withScopedWriteRepo("stSoftwareAU/NEAT-AI-Discovery", () => {
      allowedInside = isWriteRepoAllowed("stSoftwareAU/NEAT-AI-Discovery");
      return Promise.resolve();
    });

    assertEquals(allowedInside, true);
    assertEquals(isWriteRepoAllowed("stSoftwareAU/NEAT-AI-Discovery"), false);
    assert(
      logs.some((l) => l.includes("[WRITE_REPO_SCOPED_GRANT]")),
      "the scoped grant must be announced",
    );
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - a scoped grant is released when the wrapped call throws", async () => {
  try {
    captureSinks();
    seedWriteRepoAllowlist("stSoftwareAU/GRQ");
    let threw = false;
    try {
      await withScopedWriteRepo("stSoftwareAU/NEAT-AI-Discovery", () => {
        throw new Error("gh pr create failed");
      });
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    assertEquals(isWriteRepoAllowed("stSoftwareAU/NEAT-AI-Discovery"), false);
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - a scoped grant never removes a repo that was already allowed", async () => {
  try {
    captureSinks();
    seedWriteRepoAllowlist("stSoftwareAU/GRQ");
    await withScopedWriteRepo("stSoftwareAU/GRQ", () => Promise.resolve());
    assertEquals(isWriteRepoAllowed("stSoftwareAU/GRQ"), true);
    assertEquals(listAllowedWriteRepos(), ["stsoftwareau/grq"]);
  } finally {
    cleanup();
  }
});

Deno.test("write-repo-allowlist - a scoped grant blocks nothing while enforcement is inactive", async () => {
  try {
    captureSinks();
    let ran = false;
    await withScopedWriteRepo("stSoftwareAU/NEAT-AI-Discovery", () => {
      ran = true;
      return Promise.resolve();
    });
    assertEquals(ran, true);
    assertEquals(listAllowedWriteRepos(), []);
  } finally {
    cleanup();
  }
});

// ---------- `gh extension` is a local-tool mutation (Issue #1396) ----------

Deno.test("write-repo-allowlist - a pinned gh extension install is allowed, not refused as undeterminable", async () => {
  try {
    captureSinks();
    seedWriteRepoAllowlist("stSoftwareAU/VibeCoder");
    // The extension's source repo is not on the allowlist and never needs to
    // be: installing an extension writes to the local gh installation, not to
    // GitHub. Refusing it is what kept `software_updates.ts` outside the
    // `spawnGh` chokepoint (Issue #1396).
    await enforceGhWriteAllowlist([
      "extension",
      "install",
      "dlvhdr/gh-dash",
      "--pin",
      "v4.2.0",
      "--force",
    ]);
    await enforceGhWriteAllowlist(["extension", "upgrade", "gh-dash"]);
    await enforceGhWriteAllowlist(["extension", "remove", "gh-dash"]);
    await enforceGhWriteAllowlist(["extension", "list"]);
  } finally {
    cleanup();
  }
});
