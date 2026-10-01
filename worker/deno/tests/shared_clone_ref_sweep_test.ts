/**
 * Periodic sweep of shared clones for broken refs (Issue #2889).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { runGitCommand } from "../lib/git_timeout.ts";
import type { RepoLease } from "../lib/maintenance_lane.ts";
import type { SelfHealEvent } from "../lib/self_heal_events.ts";
import {
  isSweepDue,
  REPAIR_HISTORY_FILENAME,
  type SharedCloneRefSweepDeps,
  sweepSharedClone,
  sweepSharedClones,
} from "../lib/shared_clone_ref_sweep.ts";

async function git(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${
        new TextDecoder().decode(out.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(out.stdout).trim();
}

/**
 * A bare "origin" plus a shared clone under `workDir/<repoName>`, matching
 * the layout `sweepSharedClone` resolves from `repo`.
 */
async function fixture(
  repoName = "widget",
): Promise<{ root: string; workDir: string; clone: string; remote: string }> {
  const root = await Deno.makeTempDir({ prefix: "issue-2889-sweep-" });
  const workDir = `${root}/work`;
  await Deno.mkdir(workDir, { recursive: true });
  const remote = `${root}/remote.git`;
  const clone = `${workDir}/${repoName}`;

  await git(["init", "--bare", "-b", "main", remote], root);
  await git(["clone", remote, clone], root);
  await git(["config", "user.email", "t@example.com"], clone);
  await git(["config", "user.name", "Test"], clone);
  await git(["config", "commit.gpgsign", "false"], clone);

  await Deno.writeTextFile(`${clone}/README.md`, "seed\n");
  await git(["add", "."], clone);
  await git(["commit", "-m", "seed"], clone);
  await git(["push", "-u", "origin", "main"], clone);

  return { root, workDir, clone, remote };
}

function makeDeps(
  overrides: Partial<SharedCloneRefSweepDeps> = {},
): {
  deps: SharedCloneRefSweepDeps;
  logged: string[];
  errors: string[];
  events: SelfHealEvent[];
} {
  const logged: string[] = [];
  const errors: string[] = [];
  const events: SelfHealEvent[] = [];
  const deps: SharedCloneRefSweepDeps = {
    log: (m) => logged.push(m),
    logError: (m) => errors.push(m),
    emitEvent: (e) => {
      events.push(e);
      return Promise.resolve();
    },
    ...overrides,
  };
  return { deps, logged, errors, events };
}

async function cleanup(root: string): Promise<void> {
  await Deno.remove(root, { recursive: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 1. Missing-object refs (local issue-* branch + remote-tracking ref)
// ---------------------------------------------------------------------------

Deno.test(
  "#2889 - repairs a missing-object local issue-* ref and a missing-object remote-tracking ref",
  async () => {
    const { root, workDir, clone, remote } = await fixture();
    try {
      // A feature branch pushed to origin, so the remote-tracking repair has
      // something to re-fetch.
      await git(["checkout", "-b", "feat"], clone);
      await Deno.writeTextFile(`${clone}/feat.txt`, "feat\n");
      await git(["add", "feat.txt"], clone);
      await git(["commit", "-m", "feat work"], clone);
      await git(["push", "-u", "origin", "feat"], clone);
      await git(["checkout", "main"], clone);

      const fakeSha = "a".repeat(40);
      await Deno.writeTextFile(
        `${clone}/.git/refs/heads/issue-5-x`,
        `${fakeSha}\n`,
      );
      await Deno.writeTextFile(
        `${clone}/.git/refs/remotes/origin/feat`,
        `${fakeSha}\n`,
      );

      const { deps, events } = makeDeps();
      const outcome = await sweepSharedClone("acme/widget", workDir, deps);

      assertEquals(outcome.skipped, null);
      assertEquals(outcome.failures, []);
      assertEquals(outcome.repaired.length, 2);

      const issueRepair = outcome.repaired.find((r) =>
        r.ref === "refs/heads/issue-5-x"
      );
      assert(issueRepair, "expected refs/heads/issue-5-x to be repaired");
      assertEquals(issueRepair.action, "deleted");
      assertEquals(issueRepair.kind, "missing-object");

      const featRepair = outcome.repaired.find((r) =>
        r.ref === "refs/remotes/origin/feat"
      );
      assert(featRepair, "expected refs/remotes/origin/feat to be repaired");
      assertEquals(featRepair.action, "refetched");

      // The remote-tracking ref now resolves to origin's tip.
      const tip = await git(["rev-parse", "origin/feat"], clone);
      assert(tip.length === 40 && tip !== fakeSha);

      // The issue branch really is gone.
      const branches = await git(["branch", "--list", "issue-5-x"], clone);
      assertEquals(branches, "");

      // for-each-ref is healthy again.
      const forEachRef = await new Deno.Command("git", {
        args: ["for-each-ref", "refs/heads", "refs/remotes"],
        cwd: clone,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stderr = new TextDecoder().decode(forEachRef.stderr);
      assert(!stderr.includes("warning"), `unexpected warning: ${stderr}`);
      assert(!stderr.includes("fatal"), `unexpected fatal: ${stderr}`);

      assert(events.some((e) => e.action === "repair-broken-ref"));
      void remote;
    } finally {
      await cleanup(root);
    }
  },
);

// ---------------------------------------------------------------------------
// 1b. A failing `update-ref -d` is recorded as a failure, not a repair
// ---------------------------------------------------------------------------

Deno.test(
  "#2889 - a failing update-ref -d is recorded as a failure, not a repair",
  async () => {
    const { root, workDir, clone } = await fixture();
    try {
      // NUL-filled (not missing-object) so the only `update-ref -d` call in
      // this run is the one inside `deleteLocalBranchLeftovers` itself.
      await Deno.writeFile(
        `${clone}/.git/refs/heads/issue-5-x`,
        new Uint8Array(41),
      );

      const failingRunGit: typeof runGitCommand = (args, options) => {
        if (args[0] === "update-ref" && args[1] === "-d") {
          return Promise.resolve({
            ok: true,
            value: { code: 1, stdout: "", stderr: "simulated failure\n" },
          });
        }
        return runGitCommand(args, options);
      };

      const { deps } = makeDeps({ runGit: failingRunGit });
      const outcome = await sweepSharedClone("acme/widget", workDir, deps);

      assertEquals(outcome.repaired, []);
      assert(
        outcome.failures.includes("refs/heads/issue-5-x"),
        `expected a recorded failure: ${JSON.stringify(outcome.failures)}`,
      );
    } finally {
      await cleanup(root);
    }
  },
);

// ---------------------------------------------------------------------------
// 1c. A truncated, non-NUL loose ref: git warns and still exits 0
// ---------------------------------------------------------------------------

Deno.test(
  "#2889 - a truncated loose ref git only warns about (exit 0) is repaired",
  async () => {
    const { root, workDir, clone } = await fixture();
    try {
      // A partial write: a few hex characters, no newline, no NUL. git
      // prints "warning: ignoring broken ref" and still exits 0.
      await Deno.writeTextFile(
        `${clone}/.git/refs/heads/issue-7-partial`,
        "abcdef12",
      );

      const { deps } = makeDeps();
      const outcome = await sweepSharedClone("acme/widget", workDir, deps);

      assertEquals(outcome.failures, []);
      assert(
        outcome.repaired.some((r) => r.ref === "refs/heads/issue-7-partial"),
        `expected the truncated ref to be repaired: ${
          JSON.stringify(outcome.repaired)
        }`,
      );

      const forEachRef = await new Deno.Command("git", {
        args: ["for-each-ref", "refs/heads", "refs/remotes"],
        cwd: clone,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const stderr = new TextDecoder().decode(forEachRef.stderr);
      assert(!stderr.includes("warning"), `unexpected warning: ${stderr}`);
    } finally {
      await cleanup(root);
    }
  },
);

// ---------------------------------------------------------------------------
// 2. Healthy clone
// ---------------------------------------------------------------------------

Deno.test("#2889 - a healthy clone is left untouched with no events", async () => {
  const { root, workDir, clone } = await fixture();
  try {
    const before = await git(["rev-parse", "main"], clone);

    const { deps, events } = makeDeps();
    const outcome = await sweepSharedClone("acme/widget", workDir, deps);

    assertEquals(outcome.skipped, null);
    assertEquals(outcome.repaired, []);
    assertEquals(outcome.failures, []);
    assertEquals(outcome.escalated, false);
    assertEquals(events, []);

    const after = await git(["rev-parse", "main"], clone);
    assertEquals(after, before);
  } finally {
    await cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// 3. Lease held
// ---------------------------------------------------------------------------

Deno.test("#2889 - a leased repo is skipped and left untouched", async () => {
  const { root, workDir, clone } = await fixture();
  try {
    const fakeSha = "b".repeat(40);
    await Deno.writeTextFile(
      `${clone}/.git/refs/heads/issue-9-y`,
      `${fakeSha}\n`,
    );

    const { deps, events } = makeDeps({ acquireLease: () => null });
    const outcome = await sweepSharedClone("acme/widget", workDir, deps);

    assertEquals(outcome.skipped, "leased");
    assertEquals(outcome.repaired, []);
    assertEquals(events.length, 1);
    assert(events[0]);
    assertEquals(events[0].result, "skipped");

    // Still broken: untouched.
    const raw = await Deno.readTextFile(
      `${clone}/.git/refs/heads/issue-9-y`,
    );
    assertEquals(raw.trim(), fakeSha);
  } finally {
    await cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// 4. NUL-filled ref with a valid packed-refs entry
// ---------------------------------------------------------------------------

Deno.test(
  "#2889 - a NUL-filled loose ref with a valid packed-refs copy is restored from packed",
  async () => {
    const { root, workDir, clone } = await fixture();
    try {
      const packedSha = await git(["rev-parse", "main"], clone);
      await git(["pack-refs", "--all"], clone);

      // Overwrite the (now redundant) loose copy with 41 NUL bytes.
      await Deno.writeFile(
        `${clone}/.git/refs/heads/main`,
        new Uint8Array(41),
      );

      const { deps, events } = makeDeps();
      const outcome = await sweepSharedClone("acme/widget", workDir, deps);

      assertEquals(outcome.failures, []);
      const repair = outcome.repaired.find((r) => r.ref === "refs/heads/main");
      assert(repair, "expected refs/heads/main to be repaired");
      assertEquals(repair.action, "restored-from-packed");
      assertEquals(repair.kind, "nul-filled");

      const resolved = await git(["rev-parse", "main"], clone);
      assertEquals(resolved, packedSha);

      assert(events.some((e) => e.action === "repair-broken-ref"));
    } finally {
      await cleanup(root);
    }
  },
);

// ---------------------------------------------------------------------------
// 5. Escalation
// ---------------------------------------------------------------------------

Deno.test(
  "#2889 - three sweeps each repairing a ref escalate on the third, pruning old entries",
  async () => {
    const { root, workDir, clone } = await fixture();
    try {
      const historyPath = `${workDir}/${REPAIR_HISTORY_FILENAME}`;
      const staleMs = Date.now() - 25 * 60 * 60 * 1000; // outside the 24h window
      await Deno.writeTextFile(
        historyPath,
        JSON.stringify({ repairs: { "acme/widget": [staleMs] } }),
      );

      let lastOutcome;
      let lastErrors: string[] = [];
      for (let i = 0; i < 3; i++) {
        const fakeSha = "c".repeat(40);
        await Deno.writeTextFile(
          `${clone}/.git/refs/heads/issue-${i}-z`,
          `${fakeSha}\n`,
        );
        const { deps, errors } = makeDeps();
        lastOutcome = await sweepSharedClone("acme/widget", workDir, deps);
        lastErrors = errors;
      }

      assert(lastOutcome);
      assertEquals(lastOutcome.escalated, true);
      assert(
        lastErrors.some((e) => e.includes("[SHARED_CLONE_REF_CHURN]")),
        `expected a churn error: ${JSON.stringify(lastErrors)}`,
      );
      assert(lastErrors.some((e) => e.includes("acme/widget")));

      const history = JSON.parse(await Deno.readTextFile(historyPath));
      const entries: number[] = history.repairs["acme/widget"];
      assert(
        !entries.includes(staleMs),
        "the stale entry should have been pruned",
      );
      assertEquals(entries.length, 3);
    } finally {
      await cleanup(root);
    }
  },
);

// ---------------------------------------------------------------------------
// 6. Provenance
// ---------------------------------------------------------------------------

Deno.test(
  "#2889 - provenance captures a nearby OOM log and the last reflog line",
  async () => {
    const { root, workDir, clone } = await fixture();
    const logsDir = `${root}/logs`;
    try {
      await Deno.mkdir(logsDir, { recursive: true });

      // Create a genuine reflog entry for main by committing again, then
      // break the loose ref while the reflog itself stays intact.
      await Deno.writeTextFile(`${clone}/more.txt`, "more\n");
      await git(["add", "more.txt"], clone);
      await git(["commit", "-m", "more work"], clone);
      await git(["push", "origin", "main"], clone);

      const refPath = `${clone}/.git/refs/heads/main`;
      const mtimeTarget = new Date();
      await Deno.writeFile(refPath, new Uint8Array(41));
      await Deno.utime(refPath, mtimeTarget, mtimeTarget);

      const oomLogPath = `${logsDir}/oom-worker-1.log`;
      await Deno.writeTextFile(oomLogPath, "OOM killed something\n");
      await Deno.utime(oomLogPath, mtimeTarget, mtimeTarget);

      const { deps, events } = makeDeps({ logsDir });
      const outcome = await sweepSharedClone("acme/widget", workDir, deps);

      const repair = outcome.repaired.find((r) => r.ref === "refs/heads/main");
      assert(repair, "expected refs/heads/main to be repaired");
      assert(
        repair.provenance.nearbyOomLogs?.includes("oom-worker-1.log"),
        `expected nearby OOM log, got ${JSON.stringify(repair.provenance)}`,
      );
      assert(
        repair.provenance.lastReflogEntry,
        "expected a captured reflog line",
      );

      const event = events.find((e) => e.action === "repair-broken-ref");
      assert(event);
      assertStringIncludes(
        JSON.stringify(event.details),
        "oom-worker-1.log",
      );
    } finally {
      await cleanup(root);
    }
  },
);

// ---------------------------------------------------------------------------
// 7. isSweepDue
// ---------------------------------------------------------------------------

Deno.test("#2889 - isSweepDue basic cases", () => {
  const now = 1_000_000;
  assertEquals(isSweepDue(undefined, now), true);
  assertEquals(isSweepDue(now - 1000, now, 60 * 60 * 1000), false);
  assertEquals(isSweepDue(now - 2 * 60 * 60 * 1000, now, 60 * 60 * 1000), true);
});

// ---------------------------------------------------------------------------
// 8. No clone
// ---------------------------------------------------------------------------

Deno.test("#2889 - no clone directory is skipped as no-clone", async () => {
  const root = await Deno.makeTempDir({ prefix: "issue-2889-sweep-noclone-" });
  try {
    const { deps, events } = makeDeps();
    const outcome = await sweepSharedClone("acme/ghost", root, deps);
    assertEquals(outcome.skipped, "no-clone");
    assertEquals(outcome.repaired, []);
    assertEquals(events, []);
  } finally {
    await cleanup(root);
  }
});

// ---------------------------------------------------------------------------
// sweepSharedClones sequencing
// ---------------------------------------------------------------------------

Deno.test(
  "#2889 - sweepSharedClones runs sequentially and survives a thrown error",
  async () => {
    const { root, workDir } = await fixture("ok-repo");
    try {
      // Give "boom" a clone too, so the sweep reaches lease acquisition
      // (where the thrown error actually happens) rather than short-circuiting
      // on a missing clone directory.
      await Deno.mkdir(`${workDir}/boom/.git`, { recursive: true });

      const { deps, errors } = makeDeps({
        acquireLease: (repo: string): RepoLease | null => {
          if (repo === "acme/boom") throw new Error("boom");
          return { release() {} };
        },
      });
      const outcomes = await sweepSharedClones(
        ["acme/ok-repo", "acme/boom", "acme/missing"],
        workDir,
        deps,
      );
      assertEquals(outcomes.length, 3);
      const [first, second, third] = outcomes;
      assert(first && second && third);
      assertEquals(first.repo, "acme/ok-repo");
      assertEquals(second.repo, "acme/boom");
      assertEquals(second.failures.length, 1);
      assertEquals(third.skipped, "no-clone");
      assert(errors.some((e) => e.includes("acme/boom")));
    } finally {
      await cleanup(root);
    }
  },
);
