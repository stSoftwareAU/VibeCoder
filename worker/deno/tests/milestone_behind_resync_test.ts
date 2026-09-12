/**
 * The pieces the two `milestone-behind` recovery callers share
 * (Issue #2005).
 *
 * The memo is what keeps the recovery's cost equal to the memoised compare
 * it rides beside: N children of one milestone cost one sync, not N. The
 * binder is what turns a PR's base branch into a real merge, and every
 * thing it cannot resolve — the default branch, the clone — is a deferral
 * with the reason in it, never a silent "the branch is level".
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  createMilestoneResync,
  memoiseMilestoneResync,
  milestoneBehindComment,
  milestoneTitleFromBranch,
  resyncCleared,
} from "../lib/milestone_behind_resync.ts";
import type { MilestonePresyncResult } from "../lib/milestone_presync.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { Logger } from "../types.ts";

const REPO = "stSoftwareAU/VibeCoder";
const BRANCH = "milestone/1730-resolve-merge-conflicts";

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as Logger;

Deno.test("resyncCleared - only a level or synced branch clears the deferral", () => {
  assertEquals(resyncCleared({ status: "level", detail: "" }), true);
  assertEquals(resyncCleared({ status: "synced", detail: "" }), true);
  assertEquals(resyncCleared({ status: "deferred", detail: "" }), false);
});

Deno.test("memoiseMilestoneResync - one attempt per milestone branch", async () => {
  const calls: string[] = [];
  const memoised = memoiseMilestoneResync((repo, branch) => {
    calls.push(`${repo}|${branch}`);
    return Promise.resolve<MilestonePresyncResult>({
      status: "synced",
      detail: "merged",
    });
  });

  const first = await memoised(REPO, BRANCH);
  const second = await memoised(REPO, BRANCH);
  const third = await memoised(REPO, "milestone/other");
  const fourth = await memoised("other/repo", BRANCH);

  assertEquals(calls, [
    `${REPO}|${BRANCH}`,
    `${REPO}|milestone/other`,
    `other/repo|${BRANCH}`,
  ]);
  assertEquals(first, second, "the second asker reuses the first verdict");
  assertEquals(third.status, "synced");
  assertEquals(fourth.status, "synced");
});

Deno.test("memoiseMilestoneResync - a failed attempt is not retried this cycle", async () => {
  let calls = 0;
  const memoised = memoiseMilestoneResync(() => {
    calls++;
    return Promise.resolve<MilestonePresyncResult>({
      status: "deferred",
      detail: "conflict attempt 1 of 3 failed",
    });
  });

  assertEquals((await memoised(REPO, BRANCH)).status, "deferred");
  assertEquals((await memoised(REPO, BRANCH)).status, "deferred");
  assertEquals(calls, 1);
});

Deno.test("memoiseMilestoneResync - a thrown attempt reaches every asker", async () => {
  let calls = 0;
  const memoised = memoiseMilestoneResync(() => {
    calls++;
    return Promise.reject(new Error("git is unreachable"));
  });

  for (const _ of [0, 1]) {
    const error = await memoised(REPO, BRANCH).catch((err: unknown) => err);
    assert(error instanceof Error, "the failure is never swallowed");
    assertStringIncludes(error.message, "git is unreachable");
  }
  assertEquals(calls, 1);
});

Deno.test("milestoneTitleFromBranch - the slug the branch records", () => {
  assertEquals(
    milestoneTitleFromBranch(BRANCH),
    "1730-resolve-merge-conflicts",
  );
  assertEquals(milestoneTitleFromBranch("Develop"), "Develop");
  assertEquals(milestoneTitleFromBranch("milestone/"), "milestone/");
});

Deno.test("milestoneBehindComment - names the branches and the reason", () => {
  const body = milestoneBehindComment(
    BRANCH,
    "main",
    "deferred: conflict attempt 1 of 3 failed at rung agent",
  );

  assertStringIncludes(body, "Auto-merge not armed");
  assertStringIncludes(body, BRANCH);
  assertStringIncludes(body, "main");
  assertStringIncludes(body, "conflict attempt 1 of 3");
  assertStringIncludes(body, "No side-pick is taken");
});

Deno.test("createMilestoneResync - an unreadable default branch defers, loudly", async () => {
  const resync = createMilestoneResync({
    workDir: "/tmp/does-not-matter",
    config: buildDefaultWorkerConfig(),
    logger: silentLogger,
    ghCommandFn: () => Promise.resolve(""),
    defaultBranchFn: () =>
      Promise.resolve({ ok: false, error: new Error("HTTP 403") }),
    ensureCloneFn: () =>
      Promise.resolve({ ok: true, repoPath: "/tmp/clone", cloned: false }),
  });

  const outcome = await resync(REPO, BRANCH);

  assertEquals(outcome.status, "deferred");
  assertStringIncludes(outcome.detail, "default branch");
  assertStringIncludes(outcome.detail, "HTTP 403");
});

Deno.test("createMilestoneResync - a missing clone defers, loudly", async () => {
  const resync = createMilestoneResync({
    workDir: "/tmp/does-not-matter",
    config: buildDefaultWorkerConfig(),
    logger: silentLogger,
    ghCommandFn: () => Promise.resolve(""),
    defaultBranchFn: () => Promise.resolve({ ok: true, value: "main" }),
    ensureCloneFn: () =>
      Promise.resolve({
        ok: false,
        repoPath: "/tmp/clone",
        cloned: false,
        message: "clone refused: no disk space",
      }),
  });

  const outcome = await resync(REPO, BRANCH);

  assertEquals(outcome.status, "deferred");
  assertStringIncludes(outcome.detail, "clone");
  assertStringIncludes(outcome.detail, "no disk space");
});
