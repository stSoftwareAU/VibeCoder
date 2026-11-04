/**
 * Tests for audit_hook.ts — the chokepoint hooks that journal GitHub
 * mutations (Issue #2380; coverage gap closed by Issue #3117).
 *
 * These WHAT-tests drive the two exported functions `auditGhMutation` and
 * `auditGitMutation` and assert on their observable effect — the journal
 * entries actually written — never on internal call order. The journal is
 * read back through the production `auditFilePath`/`loadEntries` helpers, so
 * the tests survive a refactor of how journalling is wired.
 *
 * Gating and identity used to be read straight off the process (`WORK_DIR`
 * set, `VIBE_AUDIT_DISABLED` unset, `WORKER_UNIQUE_ID`, `VIBE_RUN_ID`), so
 * each test had to set four environment variables and put them back — a
 * mutation that races every other test running at that moment and pinned this
 * file into the gate's serial pass (Issue #880). Issue #963 made all four
 * parameters, so each test now hands the hook a fixed map instead.
 *
 * Every injected value is a sentinel that exists in no real environment — the
 * temp `WORK_DIR`, `test-hook-worker`, `run-hook-1`, and a
 * `VIBE_AUDIT_DISABLED` that is only ever set in the map. A code path that
 * quietly fell back to `Deno.env.get` would resolve a different journal path,
 * a different run id, or the wrong gating verdict, and fail here rather than
 * pass on an ambient value.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  actionKindFor,
  auditGhMutation,
  auditGitMutation,
  type AuditHookOptions,
  callerFromStack,
  componentFor,
  prNumberFor,
} from "../lib/audit_hook.ts";
import {
  _resetAuditCaches,
  auditFilePath,
  loadEntries,
  verifyAllChains,
} from "../lib/audit_journal.ts";
import {
  classifyGhMutation,
  classifyGitMutation,
  type MutationInfo,
} from "../lib/audit_mutation_classifier.ts";
import { buildPushArgs } from "../lib/git_ref_args.ts";
import { envFrom } from "./support/env_lookup.ts";

/** Worker partition these tests journal under — a sentinel, not a real id. */
const WORKER_ID = "test-hook-worker";

/** Run id these tests expect on every entry — likewise a sentinel. */
const RUN_ID = "run-hook-1";

/**
 * Run `fn` with a fresh isolated audit environment.
 *
 * Builds a lookup carrying a unique temp `WORK_DIR`, a fixed worker/run id
 * for deterministic paths, and no `VIBE_AUDIT_DISABLED`; resets the
 * in-process journal caches; and passes `fn` both the resolved journal path
 * and the options to hand the hook. Optionally omits `WORK_DIR` so the inert
 * (gating-off) path can be exercised, or sets `VIBE_AUDIT_DISABLED`.
 */
async function withAuditEnv(
  fn: (journalPath: string, opts: AuditHookOptions) => Promise<void>,
  spec: { disabled?: boolean; noWorkDir?: boolean } = {},
): Promise<void> {
  const workDir = await Deno.makeTempDir();
  const env = envFrom({
    ...(spec.noWorkDir ? {} : { WORK_DIR: workDir }),
    ...(spec.disabled ? { VIBE_AUDIT_DISABLED: "1" } : {}),
    WORKER_UNIQUE_ID: WORKER_ID,
    VIBE_RUN_ID: RUN_ID,
  });
  const opts: AuditHookOptions = { env };
  _resetAuditCaches();
  // Resolve the journal path through the same lookup the hook will use.
  const journalPath = spec.noWorkDir
    ? `${workDir}/audit/never-written.jsonl`
    : auditFilePath({ env });
  await fn(journalPath, opts);
}

Deno.test("audit_hook - auditGhMutation journals a gh mutation", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(["issue", "close", "42"], 0, opts);

    const loaded = await loadEntries(journalPath);
    assert(loaded.ok, "journal file should exist after a mutation");
    if (!loaded.ok) return;
    assertEquals(loaded.value.length, 1, "exactly one entry written");
    const entry = loaded.value[0];
    assertEquals(entry?.verb, "issue-close");
    assertEquals(entry?.outcome, "success");
    assertEquals(entry?.exitCode, 0);
    assertEquals(entry?.target, "42");
    assertEquals(entry?.runId, RUN_ID);
  });
});

Deno.test("audit_hook - PR mutations carry a worker action id and PR number", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(
      [
        "pr",
        "merge",
        "42",
        "--repo",
        "org/repo",
        "--match-head-commit",
        "a".repeat(40),
      ],
      0,
      opts,
    );
    const loaded = await loadEntries(journalPath);
    assert(loaded.ok);
    if (!loaded.ok) return;
    const entry = loaded.value[0];
    assertEquals(entry?.actionKind, "merge");
    assertEquals(entry?.prNumber, 42);
    assertEquals(entry?.headSha, "a".repeat(40));
    assertEquals(entry?.component, "unknown");
    assert(
      entry?.actionId !== undefined && /^[0-9a-f-]{36}$/.test(entry.actionId),
    );
    assertEquals(entry?.outcome, "success");
  });
});

Deno.test("audit_hook - a PR review dismissal is recorded as a distinct action", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(
      [
        "api",
        "-X",
        "PUT",
        "repos/org/repo/pulls/42/reviews/777",
        "-f",
        "state=DISMISSED",
      ],
      0,
      opts,
    );
    const loaded = await loadEntries(journalPath);
    assert(loaded.ok);
    if (!loaded.ok) return;
    assertEquals(loaded.value[0]?.actionKind, "dismissal");
    assertEquals(loaded.value[0]?.prNumber, 42);
  });
});

Deno.test("audit_hook - a worker dismissal via the /dismissals endpoint is journalled as a dismissal with its PR number", async () => {
  // The exact argv markCommentProcessed (pr_comments.ts) hands runGhOrThrow:
  // a PUT to the /dismissals sub-endpoint carrying a message, no state field.
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(
      [
        "api",
        "-X",
        "PUT",
        "repos/org/repo/pulls/42/reviews/777/dismissals",
        "-f",
        "message=Processed",
      ],
      0,
      opts,
    );
    const loaded = await loadEntries(journalPath);
    assert(loaded.ok);
    if (!loaded.ok) return;
    assertEquals(loaded.value[0]?.verb, "api-put");
    assertEquals(loaded.value[0]?.actionKind, "dismissal");
    assertEquals(loaded.value[0]?.prNumber, 42);
  });
});

Deno.test("audit_hook - a gh extension install is journalled as a local-tool mutation (Issue #1396)", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(
      ["extension", "install", "dlvhdr/gh-dash", "--pin", "v4.2.0", "--force"],
      0,
      opts,
    );

    const loaded = await loadEntries(journalPath);
    assert(loaded.ok, "journal file should exist after an extension install");
    if (!loaded.ok) return;
    assertEquals(loaded.value.length, 1);
    const entry = loaded.value[0];
    assertEquals(entry?.verb, "extension-install");
    assertEquals(entry?.target, "dlvhdr/gh-dash");
    assertEquals(entry?.outcome, "success");
    // The extension's source repo is not a write target, so it is not
    // recorded as the mutated repo.
    assertEquals(entry?.repo, undefined);
  });
});

Deno.test("audit_hook - gh extension list stays a read and is not journalled (Issue #1396)", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(["extension", "list"], 0, opts);
    const loaded = await loadEntries(journalPath);
    assertEquals(loaded.ok, false, "a read must write no journal entry");
  });
});

Deno.test("audit_hook - non-zero exit records an error outcome", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(["issue", "close", "42"], 1, opts);

    const loaded = await loadEntries(journalPath);
    assert(loaded.ok);
    if (!loaded.ok) return;
    assertEquals(loaded.value.length, 1);
    assertEquals(loaded.value[0]?.outcome, "error");
    assertEquals(loaded.value[0]?.exitCode, 1);
  });
});

Deno.test("audit_hook - auditGhMutation ignores a read-only command", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(["issue", "view", "42"], 0, opts);

    // No mutation classified → no journal file should be created at all.
    const loaded = await loadEntries(journalPath);
    assertEquals(loaded.ok, false, "a non-mutation must not write an entry");
  });
});

Deno.test("audit_hook - VIBE_AUDIT_DISABLED makes the hook inert", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(["issue", "close", "42"], 0, opts);

    const loaded = await loadEntries(journalPath);
    assertEquals(loaded.ok, false, "disabled gating must not write");
  }, { disabled: true });
});

Deno.test("audit_hook - hook is inert when WORK_DIR is unset", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    // Must not throw even though there is no journal location.
    await auditGhMutation(["issue", "close", "42"], 0, opts);
    await auditGitMutation(["push", "origin", "main"], 0, opts);

    const loaded = await loadEntries(journalPath);
    assertEquals(loaded.ok, false, "no journal written without WORK_DIR");
  }, { noWorkDir: true });
});

Deno.test("audit_hook - auditGitMutation journals a git push", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGitMutation(["push", "origin", "feature-branch"], 0, opts);

    const loaded = await loadEntries(journalPath);
    assert(loaded.ok);
    if (!loaded.ok) return;
    assertEquals(loaded.value.length, 1);
    assertEquals(loaded.value[0]?.verb, "git-push");
    assertEquals(loaded.value[0]?.target, "feature-branch");
    assertEquals(loaded.value[0]?.outcome, "success");
  });
});

Deno.test("audit_hook - auditGitMutation ignores a non-push git command", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGitMutation(["status"], 0, opts);

    const loaded = await loadEntries(journalPath);
    assertEquals(loaded.ok, false, "a local git command must not write");
  });
});

Deno.test("audit_hook - push delivery evidence is journalled and chain verified", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGitMutation(["push", "origin", "feature"], 0, {
      ...opts,
      deliveredCommits: ["a".repeat(40)],
    });
    const loaded = await loadEntries(journalPath);
    assert(loaded.ok);
    assertEquals(loaded.value[0]?.deliveredCommits, ["a".repeat(40)]);
    const verified = await verifyAllChains(
      journalPath.slice(0, journalPath.lastIndexOf("/")),
    );
    assert(verified.ok);
    assertEquals(verified.value.broken, []);
    await Deno.writeTextFile(
      journalPath,
      (await Deno.readTextFile(journalPath)).replace(
        "a".repeat(40),
        "b".repeat(40),
      ),
    );
    const edited = await verifyAllChains(
      journalPath.slice(0, journalPath.lastIndexOf("/")),
    );
    assert(edited.ok);
    assertEquals(edited.value.broken.length, 1);
  });
});

Deno.test("audit_hook - an explicit run id overrides the environment (Issue #963)", async () => {
  // The run id is the join key between the GitHub timeline and the worker
  // logs, so the hook must stamp the value it was handed — not one it went
  // looking for. Both candidates are sentinels, so whichever the entry
  // carries names where it came from.
  await withAuditEnv(async (journalPath, opts) => {
    await auditGhMutation(["issue", "close", "42"], 0, {
      ...opts,
      runId: "run-hook-explicit-963",
    });

    const loaded = await loadEntries(journalPath);
    assert(loaded.ok, "journal file should exist after a mutation");
    if (!loaded.ok) return;
    assertEquals(loaded.value[0]?.runId, "run-hook-explicit-963");
  });
});

Deno.test("audit_hook - the journal path follows the injected worker identity (Issue #963)", async () => {
  // The partition is per worker, and the worker id used to come off the
  // process. Proving it follows the injected lookup is what makes the
  // path this file asserts against the hook's own, not a coincidence.
  await withAuditEnv(async (journalPath, opts) => {
    await auditGitMutation(["push", "origin", "feature-branch"], 0, opts);

    assert(
      journalPath.includes(`/audit-${WORKER_ID}-`),
      `expected the injected worker id in the journal path, got: ${journalPath}`,
    );
    const loaded = await loadEntries(journalPath);
    assert(loaded.ok, "the hook wrote to the path the injected lookup names");
  });
});

// Issue #4658: component and action-kind classification. Each MutationInfo
// comes from the real classifier, and each outcome is asserted on the real
// decision functions the hook calls. A test stack has no lib or commands
// frame, so the journal-level test below sees an unresolved caller; the
// caller-path outcomes are driven through componentFor, actionKindFor and
// callerFromStack instead.

/** Classify `args` as a gh mutation, failing the test if it is not one. */
function ghInfo(args: readonly string[]): MutationInfo {
  const info = classifyGhMutation(args);
  assert(info, `expected gh ${args.join(" ")} to classify as a mutation`);
  return info;
}

/** Classify `args` as a git mutation, failing the test if it is not one. */
function gitInfo(args: readonly string[]): MutationInfo {
  const info = classifyGitMutation(args);
  assert(info, `expected git ${args.join(" ")} to classify as a mutation`);
  return info;
}

/** Repo-relative caller path of a module under worker/deno/. */
function callerIn(dir: "lib" | "commands", file: string): string {
  return `worker/deno/${dir}/${file}`;
}

/** The action kind the hook assigns to a gh invocation from `caller`. */
function ghKind(args: string[], caller?: string) {
  return actionKindFor(ghInfo(args), caller, args);
}

/** The action kind the hook assigns to a `git push` from `caller`. */
function pushKind(caller?: string) {
  const args = ["push", "origin", "feature-branch"];
  return actionKindFor(gitInfo(args), caller, args);
}

Deno.test("audit_hook - componentFor names the babysitter, reviewer and worker from their caller path", () => {
  assertEquals(
    componentFor(callerIn("commands", "fleet_pr_babysitter.ts")),
    "babysitter",
  );
  assertEquals(componentFor(callerIn("lib", "review_round.ts")), "reviewer");
  assertEquals(componentFor(callerIn("lib", "pr_ci_processor.ts")), "worker");
  assertEquals(
    componentFor(callerIn("lib", "pr_feedback_processor.ts")),
    "worker",
  );
  assertEquals(componentFor(callerIn("lib", "agent_pr_adoption.ts")), "worker");
  assertEquals(componentFor(callerIn("lib", "pr_maintenance.ts")), "worker");
  assertEquals(componentFor(callerIn("lib", "git_pull.ts")), "worker");
  assertEquals(
    componentFor(callerIn("lib", "phases/completion_phase.ts")),
    "worker",
  );
});

Deno.test("audit_hook - componentFor is unknown when the caller is unresolved or unlisted", () => {
  assertEquals(componentFor(undefined), "unknown");
  // An unlisted module is not assumed to be the worker.
  assertEquals(componentFor(callerIn("lib", "recent_activity.ts")), "unknown");
});

Deno.test("audit_hook - callerFromStack skips the audit and gh/git chokepoints to the requesting module", () => {
  const stack = [
    "Error",
    "    at resolveCaller (file:///srv/VibeCoder/worker/deno/lib/audit_hook.ts:101:11)",
    "    at record (file:///srv/VibeCoder/worker/deno/lib/audit_hook.ts:170:20)",
    "    at spawnGh (file:///srv/VibeCoder/worker/deno/lib/gh_spawn.ts:656:5)",
    "    at async runGhOrThrow (file:///srv/VibeCoder/worker/deno/lib/gh_spawn.ts:691:10)",
    "    at async runGhCommandRaw (file:///srv/VibeCoder/worker/deno/lib/github.ts:290:3)",
    "    at async retryWithBackoff (file:///srv/VibeCoder/worker/deno/lib/retry.ts:180:18)",
    "    at async runGhCommand (file:///srv/VibeCoder/worker/deno/lib/github.ts:514:10)",
    "    at async run (file:///srv/VibeCoder/worker/deno/commands/fleet_pr_babysitter.ts:322:12)",
  ].join("\n");
  assertEquals(
    callerFromStack(stack),
    "worker/deno/commands/fleet_pr_babysitter.ts",
  );
});

// The stacks below mirror the worker's real push chains (traced for Issue #4658
// review). Each push is journalled in `runGitCommand` (git_timeout.ts:366).
// `pushUnpushedCommits` (git_push.ts:388) makes that call, and
// `commitAndPushPending` (git_push.ts:992) calls `pushUnpushedCommits`. The
// requester is the first frame above git_push.ts: completion_phase.ts:1915
// calls `pushUnpushedCommits` directly; pr_ci_processor.ts:2153 and
// pr_feedback_processor.ts:1684 call `commitAndPushPending`. Frames are trimmed
// to the ones that decide the caller.

Deno.test("audit_hook - callerFromStack skips the git push primitive to the completion phase that asked for it", () => {
  const stack = [
    "    at auditGitMutation (file:///srv/VibeCoder/worker/deno/lib/audit_hook.ts:308:3)",
    "    at runGitCommand (file:///srv/VibeCoder/worker/deno/lib/git_timeout.ts:366:5)",
    "    at pushUnpushedCommits (file:///srv/VibeCoder/worker/deno/lib/git_push.ts:388:20)",
    "    at async gateBeforePush (file:///srv/VibeCoder/worker/deno/lib/phases/completion_phase.ts:1915:24)",
  ].join("\n");
  assertEquals(
    callerFromStack(stack),
    "worker/deno/lib/phases/completion_phase.ts",
  );
});

Deno.test("audit_hook - callerFromStack resolves a PR processor's push through commitAndPushPending to the processor", () => {
  const ciStack = [
    "    at auditGitMutation (file:///srv/VibeCoder/worker/deno/lib/audit_hook.ts:308:3)",
    "    at runGitCommand (file:///srv/VibeCoder/worker/deno/lib/git_timeout.ts:366:5)",
    "    at pushUnpushedCommits (file:///srv/VibeCoder/worker/deno/lib/git_push.ts:388:20)",
    "    at async commitAndPushPending (file:///srv/VibeCoder/worker/deno/lib/git_push.ts:992:22)",
    "    at async _processCiWithHeartbeat (file:///srv/VibeCoder/worker/deno/lib/pr_ci_processor.ts:2153:37)",
  ].join("\n");
  const feedbackStack = [
    "    at auditGitMutation (file:///srv/VibeCoder/worker/deno/lib/audit_hook.ts:308:3)",
    "    at runGitCommand (file:///srv/VibeCoder/worker/deno/lib/git_timeout.ts:366:5)",
    "    at pushUnpushedCommits (file:///srv/VibeCoder/worker/deno/lib/git_push.ts:388:20)",
    "    at async commitAndPushPending (file:///srv/VibeCoder/worker/deno/lib/git_push.ts:992:22)",
    "    at finalise (file:///srv/VibeCoder/worker/deno/lib/pr_feedback_processor.ts:1684:7)",
  ].join("\n");
  assertEquals(
    callerFromStack(ciStack),
    "worker/deno/lib/pr_ci_processor.ts",
  );
  assertEquals(
    callerFromStack(feedbackStack),
    "worker/deno/lib/pr_feedback_processor.ts",
  );
  assertEquals(pushKind(callerFromStack(ciStack)), "repair");
  assertEquals(pushKind(callerFromStack(feedbackStack)), "repair");
});

Deno.test("audit_hook - recovery push retains the requesting processor kind", () => {
  const stack = [
    "    at auditGitMutation (file:///srv/VibeCoder/worker/deno/lib/audit_hook.ts:308:3)",
    "    at runGitCommand (file:///srv/VibeCoder/worker/deno/lib/git_timeout.ts:366:5)",
    "    at recoverFromPushRejection (file:///srv/VibeCoder/worker/deno/lib/git_push_recovery.ts:300:5)",
    "    at pushUnpushedCommits (file:///srv/VibeCoder/worker/deno/lib/git_push.ts:400:5)",
    "    at finalise (file:///srv/VibeCoder/worker/deno/lib/pr_feedback_processor.ts:1684:7)",
  ].join("\n");
  assertEquals(
    callerFromStack(stack),
    "worker/deno/lib/pr_feedback_processor.ts",
  );
  assertEquals(pushKind(callerFromStack(stack)), "repair");
});

Deno.test("audit_hook - callerFromStack keeps a lib subdirectory caller", () => {
  const stack = [
    "    at auditGitMutation (file:///srv/VibeCoder/worker/deno/lib/audit_hook.ts:308:3)",
    "    at runGitCommand (file:///srv/VibeCoder/worker/deno/lib/git_timeout.ts:366:5)",
    "    at async gateBeforePush (file:///srv/VibeCoder/worker/deno/lib/phases/completion_phase.ts:1915:24)",
  ].join("\n");
  assertEquals(
    callerFromStack(stack),
    "worker/deno/lib/phases/completion_phase.ts",
  );
});

function mutationFor(verb: string, target?: string): MutationInfo {
  return { verb, target, scope: "explicit" };
}

Deno.test("audit_hook - prNumberFor is undefined when the mutation has no target", () => {
  assertEquals(prNumberFor(mutationFor("pr-merge")), undefined);
});

Deno.test("audit_hook - prNumberFor is undefined for a pr- verb whose target is not a number", () => {
  assertEquals(
    prNumberFor(mutationFor("pr-merge", "feature-branch")),
    undefined,
  );
});

Deno.test("audit_hook - prNumberFor is undefined for a target beyond the safe integer range", () => {
  assertEquals(
    prNumberFor(mutationFor("pr-merge", "9007199254740993")),
    undefined,
  );
});

Deno.test("audit_hook - prNumberFor reads the PR number from a /pulls/N API target", () => {
  assertEquals(
    prNumberFor(mutationFor("api-put", "repos/org/repo/pulls/42/reviews/7")),
    42,
  );
});

Deno.test("audit_hook - prNumberFor reads the number of a numeric pr- verb target", () => {
  assertEquals(prNumberFor(mutationFor("pr-merge", "42")), 42);
});

Deno.test("audit_hook - callerFromStack matches whole file names, not suffixes", () => {
  const stack = [
    "    at spawnGh (file:///srv/VibeCoder/worker/deno/lib/gh_spawn.ts:656:5)",
    "    at async pushRecovery (file:///srv/VibeCoder/worker/deno/lib/push_recovery_retry.ts:40:7)",
  ].join("\n");
  // push_recovery_retry.ts ends in retry.ts but is a different module.
  assertEquals(
    callerFromStack(stack),
    "worker/deno/lib/push_recovery_retry.ts",
  );
});

Deno.test("audit_hook - callerFromStack is undefined without a requesting module", () => {
  assertEquals(callerFromStack(undefined), undefined);
  assertEquals(callerFromStack(""), undefined);
  const plumbingOnly = [
    "    at spawnGh (file:///srv/VibeCoder/worker/deno/lib/gh_spawn.ts:656:5)",
    "    at async runGhCommand (file:///srv/VibeCoder/worker/deno/lib/github.ts:514:10)",
    "    at async retryWithBackoff (file:///srv/VibeCoder/worker/deno/lib/retry.ts:180:18)",
  ].join("\n");
  assertEquals(callerFromStack(plumbingOnly), undefined);
});

Deno.test("audit_hook - actionKindFor names merge and review from the verb", () => {
  assertEquals(ghKind(["pr", "merge", "42", "--repo", "org/repo"]), "merge");
  assertEquals(
    ghKind(["pr", "review", "42", "--repo", "org/repo", "--approve"]),
    "review",
  );
});

Deno.test("audit_hook - disarming auto-merge is not a merge", () => {
  assertEquals(
    ghKind(["pr", "merge", "42", "--repo", "org/repo", "--disable-auto"]),
    "unknown",
  );
  assertEquals(
    ghKind(["pr", "merge", "42", "--repo", "org/repo", "--auto"]),
    "merge-arm",
  );
});

Deno.test("audit_hook - actionKindFor records a review dismissal only when the state is DISMISSED", () => {
  const endpoint = ["api", "-X", "PUT", "repos/org/repo/pulls/42/reviews/777"];
  assertEquals(ghKind([...endpoint, "-f", "state=DISMISSED"]), "dismissal");
  // The same endpoint without the dismissed state is not a dismissal.
  assertEquals(ghKind([...endpoint, "-f", "message=x"]), "unknown");
});

Deno.test("audit_hook - actionKindFor records a worker dismissal through the /dismissals endpoint", () => {
  // The argv shape markCommentProcessed builds in pr_comments.ts.
  assertEquals(
    ghKind([
      "api",
      "-X",
      "PUT",
      "repos/org/repo/pulls/42/reviews/777/dismissals",
      "-f",
      "message=Processed",
    ]),
    "dismissal",
  );
});

Deno.test("audit_hook - actionKindFor leaves a review sub-endpoint other than /dismissals unknown", () => {
  // A nearby review endpoint is not a dismissal, whatever its fields say.
  assertEquals(
    ghKind([
      "api",
      "-X",
      "PUT",
      "repos/org/repo/pulls/42/reviews/777/comments",
      "-f",
      "message=x",
    ]),
    "unknown",
  );
});

Deno.test("audit_hook - actionKindFor names an implementation push only from its own caller", () => {
  for (
    const name of [
      "wip_checkpoint",
      "run_wip_preservation",
      "declared_handoff",
      "push_recovery_retry",
    ]
  ) {
    assertEquals(pushKind(callerIn("lib", `${name}.ts`)), "implementation");
  }
  assertEquals(
    pushKind(callerIn("lib", "agent_pr_adoption.ts")),
    "implementation",
  );
  assertEquals(
    pushKind(callerIn("lib", "phases/completion_phase.ts")),
    "implementation",
  );
  assertEquals(
    pushKind(callerIn("lib", "pre_push_gate_retry.ts")),
    "implementation",
  );
});

Deno.test("audit_hook - actionKindFor names a repair push from the babysitter and the PR processors", () => {
  assertEquals(
    pushKind(callerIn("commands", "fleet_pr_babysitter.ts")),
    "repair",
  );
  assertEquals(pushKind(callerIn("lib", "pr_ci_processor.ts")), "repair");
  assertEquals(pushKind(callerIn("lib", "pr_feedback_processor.ts")), "repair");
  assertEquals(
    pushKind(callerIn("lib", "pr_merge_conflict_processor.ts")),
    "repair",
  );
});

/** The action kind the hook assigns to a `git push` of `args` from `caller`. */
function pushKindFor(args: string[], caller?: string) {
  return actionKindFor(gitInfo(args), caller, args);
}

/** Frames of the milestone sync push (`pushSyncedMilestoneBranch`). */
const GIT_PULL_MILESTONE_STACK = [
  "    at auditGitMutation (file:///srv/VibeCoder/worker/deno/lib/audit_hook.ts:373:3)",
  "    at runGitCommand (file:///srv/VibeCoder/worker/deno/lib/git_timeout.ts:366:5)",
  "    at pushSyncedMilestoneBranch (file:///srv/VibeCoder/worker/deno/lib/git_pull.ts:242:17)",
  "    at async syncMilestone (file:///srv/VibeCoder/worker/deno/lib/git_pull.ts:901:9)",
].join("\n");

/** Frames of a PR feature-branch update (`updatePrBranch` -> `pushFeatureBranch`). */
const GIT_PULL_FEATURE_STACK = [
  "    at auditGitMutation (file:///srv/VibeCoder/worker/deno/lib/audit_hook.ts:373:3)",
  "    at runGitCommand (file:///srv/VibeCoder/worker/deno/lib/git_timeout.ts:366:5)",
  "    at pushFeatureBranch (file:///srv/VibeCoder/worker/deno/lib/git_pull.ts:1651:20)",
  "    at async updatePrBranch (file:///srv/VibeCoder/worker/deno/lib/git_pull.ts:1615:22)",
].join("\n");

Deno.test("audit_hook - a push with no resolved caller is unknown, not milestone", () => {
  assertEquals(pushKind(undefined), "unknown");
});

Deno.test("audit_hook - a git_pull push to a milestone branch is a milestone action", () => {
  const caller = callerFromStack(GIT_PULL_MILESTONE_STACK);
  assertEquals(caller, "worker/deno/lib/git_pull.ts");
  assertEquals(
    pushKindFor(["push", "origin", "milestone/foo"], caller),
    "milestone",
  );
  assertEquals(
    pushKindFor(buildPushArgs("origin", "milestone/foo"), caller),
    "milestone",
  );
});

Deno.test("audit_hook - a git_pull feature-branch update is branch-update, not milestone", () => {
  const caller = callerFromStack(GIT_PULL_FEATURE_STACK);
  assertEquals(caller, "worker/deno/lib/git_pull.ts");
  assertEquals(
    pushKindFor(buildPushArgs("origin", "feature-branch"), caller),
    "branch-update",
  );
  assertEquals(
    pushKindFor(["push", "origin", "feature-branch"], caller),
    "branch-update",
  );
});

Deno.test("audit_hook - a push with no resolved caller is journalled as component and kind unknown", async () => {
  await withAuditEnv(async (journalPath, opts) => {
    await auditGitMutation(["push", "origin", "feature-branch"], 0, opts);

    const loaded = await loadEntries(journalPath);
    assert(loaded.ok);
    if (!loaded.ok) return;
    const entry = loaded.value[0];
    assertEquals(entry?.component, "unknown");
    assertEquals(entry?.actionKind, "unknown");
    assertEquals(entry?.caller, undefined);
    assert(entry?.actionId !== undefined);
  });
});
