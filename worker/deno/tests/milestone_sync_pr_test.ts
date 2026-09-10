/**
 * Tests for milestone_sync_pr.ts — landing a milestone sync through a PR when
 * the branch is gated (Issue #589).
 *
 * Measured as the service account itself, against the live ruleset:
 *
 *     remote: - 2 of 2 required status checks are expected.
 *     ! [remote rejected] milestone/… (push declined due to repository rule violations)
 *
 * The operator's policy is that the service account must NOT bypass the gate —
 * an admin may, the fleet may not — so the ruleset is right and the sync is
 * what changes.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  isRuleViolationPush,
  raiseMilestoneSyncPr,
  SYNC_BRANCH_PREFIX,
  syncBranchFor,
} from "../lib/milestone_sync_pr.ts";

const REPO = "org/repo";
const MILESTONE = "milestone/523-idle-task-scans";
const DEFAULT = "main";

/** Records every call; the listing answers with `openPrs`. */
function fakeDeps(openPrs = "[]", pushCode = 0) {
  const git: string[][] = [];
  const gh: string[][] = [];
  return {
    git,
    gh,
    deps: {
      git: (args: string[]) => {
        git.push(args);
        return Promise.resolve({
          code: pushCode,
          stderr: pushCode === 0 ? "" : "remote rejected",
        });
      },
      gh: (args: string[]) => {
        gh.push(args);
        if (args[1] === "list") return Promise.resolve(openPrs);
        if (args[1] === "create") {
          return Promise.resolve("https://github.com/org/repo/pull/700\n");
        }
        return Promise.resolve("");
      },
    },
  };
}

Deno.test("isRuleViolationPush - recognises a gate refusing the push, and nothing else", () => {
  const refusals = [
    "! [remote rejected] milestone/x (push declined due to repository rule violations)",
    "remote: - 2 of 2 required status checks are expected.",
    "remote: error: GH006: Protected branch update failed",
    // The code on its own, without the prose (Issue #1772).
    "remote: error: GH013: refs/heads/milestone/x",
  ];
  for (const stderr of refusals) {
    assertEquals(isRuleViolationPush(stderr), true, stderr);
  }
  // Every other push failure must keep failing exactly as it did — only a
  // rule refusal is answered by raising a PR.
  for (
    const other of [
      "! [rejected] main -> main (non-fast-forward)",
      "fatal: could not read Username for 'https://github.com'",
      "fatal: unable to access ... Could not resolve host",
      "",
    ]
  ) {
    assertEquals(isRuleViolationPush(other), false, other);
  }
});

Deno.test("syncBranchFor - deterministic, so a second run updates rather than re-files", () => {
  assertEquals(
    syncBranchFor(MILESTONE),
    `${SYNC_BRANCH_PREFIX}-523-idle-task-scans`,
  );
  assertEquals(syncBranchFor(MILESTONE), syncBranchFor(MILESTONE));
  // A name the ruleset does not cover — that is the whole point.
  assert(!syncBranchFor(MILESTONE).startsWith("milestone/"));
  // Characters a ref cannot carry are normalised.
  assertStringIncludes(
    syncBranchFor("milestone/4340 the v116 slot"),
    "-the-v116-slot",
  );
});

Deno.test("raiseMilestoneSyncPr - pushes a sync branch and opens a PR into the milestone", async () => {
  const { deps, git, gh } = fakeDeps();
  const result = await raiseMilestoneSyncPr(REPO, MILESTONE, DEFAULT, deps);

  assert(result.ok);
  assertEquals(result.value.opened, true);
  assertEquals(result.value.branch, syncBranchFor(MILESTONE));

  // Pushed to the sync branch, not the gated one.
  const push = git.find((a) => a[0] === "push");
  assert(push);
  assertStringIncludes(
    push.join(" "),
    `refs/heads/${syncBranchFor(MILESTONE)}`,
  );
  assertEquals(push.includes("--force-with-lease"), true);

  const create = gh.find((a) => a[1] === "create");
  assert(create);
  assertEquals(create[create.indexOf("--base") + 1], MILESTONE);
  assertEquals(create[create.indexOf("--head") + 1], syncBranchFor(MILESTONE));

  // Armed, so it lands unattended once green.
  assert(gh.some((a) => a[1] === "merge" && a.includes("--auto")));
});

Deno.test("raiseMilestoneSyncPr - an open sync PR is updated, never duplicated", async () => {
  const { deps, gh } = fakeDeps(JSON.stringify([{ number: 700 }]));
  const result = await raiseMilestoneSyncPr(REPO, MILESTONE, DEFAULT, deps);

  assert(result.ok);
  assertEquals(result.value.opened, false);
  assertEquals(
    gh.some((a) => a[1] === "create"),
    false,
    "one open sync PR per milestone branch",
  );
});

Deno.test("raiseMilestoneSyncPr - a failed sync-branch push is reported, not swallowed", async () => {
  const { deps } = fakeDeps("[]", 1);
  const result = await raiseMilestoneSyncPr(REPO, MILESTONE, DEFAULT, deps);

  assert(!result.ok);
  assertStringIncludes(result.error.message, syncBranchFor(MILESTONE));
});

Deno.test("raiseMilestoneSyncPr - an unreadable listing files rather than losing the sync", async () => {
  // A duplicate PR is recoverable; a sync that never lands is not.
  const gh: string[][] = [];
  const result = await raiseMilestoneSyncPr(REPO, MILESTONE, DEFAULT, {
    git: () => Promise.resolve({ code: 0, stderr: "" }),
    gh: (args: string[]) => {
      gh.push(args);
      if (args[1] === "list") return Promise.reject(new Error("gh exploded"));
      return Promise.resolve("https://github.com/org/repo/pull/701\n");
    },
  });

  assert(result.ok && result.value.opened);
  assert(gh.some((a) => a[1] === "create"));
});

// ---------------------------------------------------------------------------
// Stale lease baseline (Issue #1568)
//
// `--force-with-lease` with no explicit value verifies against the
// remote-tracking ref `refs/remotes/origin/<branch>`. When that ref does not
// exist locally, git cannot verify and refuses with `(stale info)` — which is
// what a single-branch clone produces for a sync branch some *other* host
// created, because the narrow refspec never materialises it.
//
// Reproduced against real git before this was written: creating a branch that
// does not exist on the remote is fine; pushing to one that exists remotely
// with no local tracking ref is rejected every time, and nothing about it
// improves on the next cycle. NEAT-AI-Ockham's milestone sync had been
// failing this way, reporting "PUSH REFUSED by a repository rule" — a
// diagnosis that sends a reader to look at branch protection for a problem
// that is really a missing fetch.
// ---------------------------------------------------------------------------

Deno.test("raiseMilestoneSyncPr - establishes the lease baseline before pushing (Issue #1568)", async () => {
  const { deps, git } = fakeDeps();
  const result = await raiseMilestoneSyncPr(REPO, MILESTONE, DEFAULT, deps);
  assert(result.ok);

  const branch = syncBranchFor(MILESTONE);
  const fetchIndex = git.findIndex((a) => a[0] === "fetch");
  const pushIndex = git.findIndex((a) => a[0] === "push");

  assert(fetchIndex >= 0, "no fetch established the lease baseline");
  assert(
    fetchIndex < pushIndex,
    "the baseline must be fetched before the lease push, not after",
  );
  // The tracking ref the lease reads is exactly what must be populated.
  assertStringIncludes(
    git[fetchIndex]!.join(" "),
    `refs/remotes/origin/${branch}`,
  );
});

Deno.test("raiseMilestoneSyncPr - a branch absent from the remote still pushes (Issue #1568)", async () => {
  // `git fetch origin <branch>` fails when the branch does not exist yet.
  // That is the ordinary first-run case and must not stop the sync — git
  // creates the branch, and a create needs no lease baseline.
  const git: string[][] = [];
  const result = await raiseMilestoneSyncPr(REPO, MILESTONE, DEFAULT, {
    git: (args: string[]) => {
      git.push(args);
      return Promise.resolve(
        args[0] === "fetch"
          ? { code: 128, stderr: "fatal: couldn't find remote ref" }
          : { code: 0, stderr: "" },
      );
    },
    gh: (args: string[]) =>
      Promise.resolve(
        args[1] === "list"
          ? "[]"
          : args[1] === "create"
          ? "https://github.com/org/repo/pull/700\n"
          : "",
      ),
  });

  assert(result.ok, JSON.stringify(result));
  assert(git.some((a) => a[0] === "push"));
});
