/**
 * Tests for the shared pending-work helpers (Issue #1684).
 *
 * These are the primitives behind "a quality fix reaches the branch": listing
 * what is uncommitted (worker state excluded), naming those paths in a
 * bounded way, and committing them through `commitAndPushPending`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import type { PreFlightGateSpec } from "../lib/git_push.ts";
import {
  commitPendingWork,
  describePaths,
  listPendingWorkPaths,
  parsePorcelainPaths,
  type PendingWorkGit,
} from "../lib/pending_work.ts";

/** Build a git seam whose status output is scripted per call. */
function gitStub(options: {
  statuses: string[];
  commit?: (branch: string, message: string) => { ok: boolean; error?: string };
  /** Observe the pre-flight spec the chokepoint was handed. */
  onCommit?: (preFlight: PreFlightGateSpec | undefined) => void;
}): {
  git: PendingWorkGit;
  commits: Array<{ branch: string; message: string }>;
} {
  const commits: Array<{ branch: string; message: string }> = [];
  let call = 0;
  const git = {
    runGitCommand: ((args: string[]) => {
      if (args[0] === "status") {
        const stdout =
          options.statuses[Math.min(call, options.statuses.length - 1)] ?? "";
        call++;
        if (stdout === "GIT-FAILED") {
          return Promise.resolve({
            ok: true,
            value: { code: 128, stdout: "", stderr: "fatal: not a git repo" },
          });
        }
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout, stderr: "" },
        });
      }
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout: "", stderr: "" },
      });
    }) as never,
    commitAndPushPending: ((
      branch: string,
      message: string,
      _options?: unknown,
      _allowDefaultBranch?: boolean,
      preFlight?: PreFlightGateSpec,
    ) => {
      commits.push({ branch, message });
      options.onCommit?.(preFlight);
      const outcome = options.commit?.(branch, message) ?? { ok: true };
      if (!outcome.ok) {
        return Promise.resolve({
          ok: false,
          error: new Error(outcome.error ?? "refused"),
        });
      }
      return Promise.resolve({
        ok: true,
        value: {
          committedNewChanges: true,
          commitsPushed: 1,
          finalUnpushedCount: 0,
          finalUnpushedSource: "remote-head" as const,
        },
      });
    }) as never,
  } as PendingWorkGit;
  return { git, commits };
}

Deno.test("parsePorcelainPaths - reads modified, untracked and renamed paths", () => {
  assertEquals(
    parsePorcelainPaths(
      " M .github/workflows/gitleaks.yml\n?? scratch.txt\nR  old.ts -> new.ts\n",
    ),
    [".github/workflows/gitleaks.yml", "scratch.txt", "new.ts"],
  );
});

Deno.test("parsePorcelainPaths - decodes git's C-style quoting", () => {
  assertEquals(parsePorcelainPaths(' M "docs/caf\\303\\251 note.md"\n'), [
    "docs/café note.md",
  ]);
});

Deno.test("describePaths - names the paths and bounds the list at ten", () => {
  assertEquals(describePaths([]), "(none)");
  assertEquals(describePaths(["a.ts", "b.ts"]), "a.ts, b.ts");

  const many = Array.from({ length: 13 }, (_, i) => `f${i}.ts`);
  const described = describePaths(many);
  assertEquals(described.split(", ").length, 10, described);
  assertEquals(described.endsWith("(+3 more)"), true, described);
});

Deno.test("describePaths - scrubs control characters so a name cannot forge a line", () => {
  assertEquals(
    describePaths(["docs/a\nrm -rf /.md", "lib/b\u0000.ts"]),
    "docs/a?rm -rf /.md, lib/b?.ts",
  );
});

Deno.test("listPendingWorkPaths - excludes worker-owned state files (Issue #1661)", async () => {
  const { git } = gitStub({
    statuses: [
      " M lib/a.ts\n?? .heartbeat_org_repo_7\n?? .vibe_default_branch\n",
    ],
  });
  assertEquals(await listPendingWorkPaths(git, "/repo"), ["lib/a.ts"]);
});

Deno.test("listPendingWorkPaths - an unreadable status is null, not a clean tree", async () => {
  const { git } = gitStub({ statuses: ["GIT-FAILED"] });
  assertEquals(await listPendingWorkPaths(git, "/repo"), null);
});

Deno.test("commitPendingWork - commits a dirty tree and reports nothing remaining", async () => {
  const { git, commits } = gitStub({ statuses: [" M lib/a.ts\n", ""] });

  const outcome = await commitPendingWork({
    git,
    repoPath: "/repo",
    branchName: "issue-1684",
    message: "fix: quality",
  });

  assertEquals(commits, [{ branch: "issue-1684", message: "fix: quality" }]);
  assertEquals(outcome.pending, ["lib/a.ts"]);
  assertEquals(outcome.remaining, []);
  assertEquals(outcome.committed, true);
  assertEquals(outcome.statusUnknown, false);
});

Deno.test("commitPendingWork - a clean tree makes no commit", async () => {
  const { git, commits } = gitStub({ statuses: [""] });

  const outcome = await commitPendingWork({
    git,
    repoPath: "/repo",
    branchName: "issue-1684",
    message: "fix: quality",
  });

  assertEquals(commits.length, 0);
  assertEquals(outcome.pending, []);
  assertEquals(outcome.committed, false);
});

Deno.test("commitPendingWork - a refused commit leaves the paths remaining and names the error", async () => {
  const { git } = gitStub({
    statuses: [" M lib/a.ts\n", " M lib/a.ts\n"],
    commit: () => ({ ok: false, error: "pre-commit gate refused" }),
  });

  const outcome = await commitPendingWork({
    git,
    repoPath: "/repo",
    branchName: "issue-1684",
    message: "fix: quality",
  });

  assertEquals(outcome.remaining, ["lib/a.ts"]);
  assertEquals(outcome.committed, false);
  assertEquals(outcome.error, "pre-commit gate refused");
});

Deno.test("commitPendingWork - an unreadable status after the commit is reported, never assumed clean", async () => {
  const { git } = gitStub({ statuses: [" M lib/a.ts\n", "GIT-FAILED"] });

  const outcome = await commitPendingWork({
    git,
    repoPath: "/repo",
    branchName: "issue-1684",
    message: "fix: quality",
  });

  assertEquals(outcome.statusUnknown, true);
  assertEquals(outcome.committed, true);
  // The pre-commit paths stand in for an answer git could not give.
  assertEquals(outcome.remaining, ["lib/a.ts"]);
});

Deno.test("commitPendingWork - passes the repo's pre-flight gate spec to the chokepoint (Issue #3577)", async () => {
  const seen: Array<PreFlightGateSpec | undefined> = [];
  const { git } = gitStub({
    statuses: [" M lib/a.ts\n", ""],
    onCommit: (spec) => seen.push(spec),
  });

  await commitPendingWork({
    git,
    repoPath: "/repo",
    branchName: "issue-1684",
    message: "fix: quality",
    preFlight: { commands: ["./preflight.sh"] },
  });

  assertEquals(seen, [{ commands: ["./preflight.sh"] }]);
});
