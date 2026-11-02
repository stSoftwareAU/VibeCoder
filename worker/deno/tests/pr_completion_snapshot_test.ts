/**
 * Tests for the PR completion snapshot producer (Issue #4658).
 *
 * Every test runs the real collector over real temporary directories. Audit
 * journals are written by `recordMutation`, so their hash chains are genuine.
 * GitHub is a path-routed fake seam, so nothing reaches the network. Each
 * test that uses a fixture asserts through `buildPrCompletionReport`.
 *
 * Uses Australian English throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _resetAuditCaches,
  auditFilePath,
  recordMutation,
} from "../lib/audit_journal.ts";
import type { AuditMutation } from "../lib/audit_entry.ts";
import {
  buildLifecycleEvent,
  serialiseLifecycleEvent,
} from "../lib/lifecycle_ledger.ts";
import { buildPrCompletionReport } from "../lib/pr_completion_report.ts";
import {
  type CollectOptions,
  collectPrCompletionSnapshot,
  type GhJson,
} from "../lib/pr_completion_snapshot.ts";

type Json = Record<string, unknown>;

const REPO = "org/repo";
const FP = "a".repeat(64);
const COHORT = {
  start: "2026-10-01T00:00:00Z",
  end: "2026-11-01T00:00:00Z",
  observedAt: "2026-11-02T00:00:00Z",
};
const JOURNAL_DATE = "2026-10-25";

interface Fixture {
  pulls?: Record<string, Json[]>;
  reviews?: Record<string, Json[]>;
  events?: Record<string, Json[]>;
  commits?: Record<string, Json[]>;
  checks?: Record<string, Json>;
  defaultBranch?: string;
  calls: string[];
}

const pk = (number: number, repo = REPO) => `${repo}#${number}`;

/** A GitHub pull request as the list endpoint returns it (merged by default). */
function pull(number: number, extra: Json = {}): Json {
  return {
    number,
    state: "closed",
    created_at: "2026-10-20T00:00:00Z",
    merged_at: "2026-10-20T02:00:00Z",
    closed_at: "2026-10-20T02:00:00Z",
    merge_commit_sha: `merge${number}`,
    title: `Change ${number}`,
    body: "",
    labels: [],
    base: { ref: "main" },
    head: { ref: `issue-${number}`, sha: `sha${number}` },
    ...extra,
  };
}

function commit(sha: string, date: string): Json {
  return { sha, commit: { committer: { date } } };
}

/**
 * A path-routed fake of the read-only `gh api` seam. Every path is recorded,
 * so a test can prove which calls were made. An unrouted path rejects.
 */
function fakeGh(fixture: Fixture): GhJson {
  return async (path: string) => {
    fixture.calls.push(path);
    const [base, query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    const page = Number(params.get("page") ?? "1");
    const perPage = Number(params.get("per_page") ?? "100");
    const slice = (items: Json[] = []) =>
      items.slice((page - 1) * perPage, page * perPage);
    let match: RegExpExecArray | null;
    if ((match = /^repos\/([^/]+\/[^/]+)$/.exec(base!))) {
      return { default_branch: fixture.defaultBranch ?? "main" };
    }
    if ((match = /^repos\/([^/]+\/[^/]+)\/pulls$/.exec(base!))) {
      return slice(fixture.pulls?.[match[1]!]);
    }
    if (
      (match = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews$/.exec(base!))
    ) {
      return slice(fixture.reviews?.[pk(Number(match[2]), match[1])]);
    }
    if (
      (match = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/commits$/.exec(base!))
    ) {
      return slice(fixture.commits?.[pk(Number(match[2]), match[1])]);
    }
    if (
      (match = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/events$/.exec(base!))
    ) {
      return slice(fixture.events?.[pk(Number(match[2]), match[1])]);
    }
    if (
      (match = /^repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/check-runs$/.exec(
        base!,
      ))
    ) {
      return fixture.checks?.[match[1]!] ?? { total_count: 0, check_runs: [] };
    }
    throw new Error(`unrouted gh path: ${path}`);
  };
}

function emptyFixture(extra: Partial<Fixture> = {}): Fixture {
  return { calls: [], ...extra };
}

function options(
  gh: GhJson,
  extra: Partial<CollectOptions> = {},
): CollectOptions {
  return {
    repos: [REPO],
    cohort: COHORT,
    auditDirs: [],
    expected: {
      components: ["worker"],
      revision: "rev1",
      policyFingerprint: FP,
      maxHeartbeatAgeHours: 24,
    },
    gh,
    ...extra,
  };
}

/** Write journal entries into `dir` with real chain hashes. */
async function journal(
  dir: string,
  entries: Array<Partial<AuditMutation> & { verb: string }>,
): Promise<void> {
  _resetAuditCaches();
  for (const entry of entries) {
    const result = await recordMutation({
      runId: "run-1",
      outcome: "success",
      component: "worker",
      ...entry,
    }, { baseDir: dir, workerId: "test-worker", date: JOURNAL_DATE });
    assert(result.ok, result.ok ? "" : result.error.message);
  }
}

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("collect - pages the cohort, filters by creation, and flags truncation", async () => {
  // 150 cohort PRs behind one PR newer than the cohort and one older.
  const after = pull(9_000, { created_at: "2026-11-05T00:00:00Z" });
  const before = pull(3, { created_at: "2026-09-01T00:00:00Z" });
  const inCohort = Array.from(
    { length: 150 },
    (_, i) => pull(i + 1, { created_at: "2026-10-15T00:00:00Z" }),
  );
  const pulls = [after, ...inCohort, before];

  const full = emptyFixture({ pulls: { [REPO]: pulls } });
  const snapshot = await collectPrCompletionSnapshot(
    options(fakeGh(full)),
  );
  assertEquals(snapshot.input.prs.length, 150);
  assertEquals(snapshot.truncatedRepos, []);
  assert(full.calls.some((path) => path.includes("page=2")));
  assert(!full.calls.some((path) => path.includes("page=3")));

  // A cap of 100 stops after one full page and says so.
  const capped = emptyFixture({ pulls: { [REPO]: pulls } });
  const truncated = await collectPrCompletionSnapshot(
    options(fakeGh(capped), { maxPrsPerRepo: 100 }),
  );
  assertEquals(truncated.truncatedRepos, [REPO]);
  assert(!capped.calls.some((path) => path.includes("page=2")));
});

Deno.test("collect - a GitHub merge matched to a verified fleet action is unattended", async () => {
  await withDir(async (dir) => {
    await journal(dir, [
      {
        verb: "git-push",
        actionKind: "implementation",
        actionId: "a-push-1",
        repo: REPO,
        target: "issue-1",
        timestamp: "2026-10-20T00:30:00Z",
      },
      {
        verb: "pr-merge",
        actionKind: "merge",
        actionId: "a-merge-1",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T02:00:00Z",
      },
    ]);
    const fixture = emptyFixture({
      pulls: { [REPO]: [pull(1)] },
      commits: { [pk(1)]: [commit("sha1", "2026-10-20T00:25:00Z")] },
    });
    const snapshot = await collectPrCompletionSnapshot(
      options(fakeGh(fixture), { auditDirs: [dir] }),
    );
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 1);
    assertEquals(report.completion.unknownMerged, 0);
    assertEquals(
      snapshot.input.actions.filter((action) => action.actor === "unknown")
        .length,
      0,
    );
  });
});

Deno.test("collect - a branch push is linked to its PR by branch name", async () => {
  await withDir(async (dir) => {
    await journal(dir, [{
      verb: "git-push",
      actionKind: "implementation",
      actionId: "a-push-5",
      repo: REPO,
      target: "issue-5",
      timestamp: "2026-10-20T00:30:00Z",
    }]);
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({ pulls: { [REPO]: [pull(5)] } })),
        { auditDirs: [dir] },
      ),
    );
    const push = snapshot.input.actions.find((action) =>
      action.actionId === "a-push-5"
    );
    assert(push, "the push must be retained as a PR action");
    assertEquals(push.prNumber, 5);
    assertEquals(push.actor, "fleet");
    assertEquals(push.verified, true);
  });
});

Deno.test("collect - a fleet action 15 minutes from the GitHub event does not match", async () => {
  await withDir(async (dir) => {
    await journal(dir, [{
      verb: "git-push",
      actionKind: "implementation",
      actionId: "a-push-6",
      repo: REPO,
      target: "issue-6",
      timestamp: "2026-10-20T00:15:00Z",
    }]);
    const fixture = emptyFixture({
      pulls: {
        [REPO]: [pull(6, { merged_at: null, state: "open", closed_at: null })],
      },
      commits: { [pk(6)]: [commit("sha6", "2026-10-20T00:00:00Z")] },
    });
    const snapshot = await collectPrCompletionSnapshot(
      options(fakeGh(fixture), { auditDirs: [dir] }),
    );
    assert(
      snapshot.input.actions.some((action) =>
        action.actionId === "gh:org/repo#6:implementation:sha6" &&
        action.actor === "unknown" && action.verified === false
      ),
      "a push 15 minutes away must leave the commit group unknown",
    );
  });
});

Deno.test("collect - unmatched GitHub merges and approvals are unknown, never human or fleet", async () => {
  const fixture = emptyFixture({
    pulls: { [REPO]: [pull(2)] },
    reviews: {
      [pk(2)]: [
        {
          id: 501,
          state: "APPROVED",
          submitted_at: "2026-10-20T01:00:00Z",
          user: { login: "release-bot[bot]" },
        },
        {
          id: 502,
          state: "COMMENTED",
          submitted_at: "2026-10-20T01:10:00Z",
          user: { login: "alice" },
        },
      ],
    },
    commits: { [pk(2)]: [commit("sha2", "2026-10-20T00:10:00Z")] },
  });
  // No audit directory: the evidence is incomplete, so every action is unknown.
  const snapshot = await collectPrCompletionSnapshot(
    options(fakeGh(fixture)),
  );
  const actions = snapshot.input.actions;
  assertEquals(actions.length, 4);
  for (const action of actions) {
    assertEquals(action.actor, "unknown");
    assertEquals(action.verified, false);
    assertEquals(action.outcome, "unknown");
    assertEquals(action.actorLogin, undefined);
  }
  assertEquals(
    actions.map((action) => action.actionId).sort(),
    [
      "gh:org/repo#2:implementation:sha2",
      "gh:org/repo#2:merge:merge2",
      "gh:org/repo#2:review:501",
      "gh:org/repo#2:review:502",
    ],
  );
  const report = buildPrCompletionReport(snapshot.input);
  assertEquals(report.completion.humanAssistedMerged, 0);
  assertEquals(report.completion.unattendedMerged, 0);
  assertEquals(report.completion.unknownMerged, 1);
});

Deno.test("collect - a broken audit chain leaves its actions unverified and the history incomplete", async () => {
  await withDir(async (dir) => {
    await journal(dir, [{
      verb: "pr-merge",
      actionKind: "merge",
      actionId: "a-merge-1",
      repo: REPO,
      prNumber: 1,
      timestamp: "2026-10-20T02:00:00Z",
    }]);
    const path = auditFilePath({
      baseDir: dir,
      workerId: "test-worker",
      date: JOURNAL_DATE,
    });
    const text = await Deno.readTextFile(path);
    assertStringIncludes(text, '"outcome":"success"');
    await Deno.writeTextFile(
      path,
      text.replace('"outcome":"success"', '"outcome":"error"'),
    );
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({ pulls: { [REPO]: [pull(1)] } })),
        { auditDirs: [dir] },
      ),
    );
    assertEquals(snapshot.input.prs[0]!.actionsComplete, false);
    const merge = snapshot.input.actions.find((action) =>
      action.actionId === "a-merge-1"
    );
    assert(merge, "an unverified action is still reported");
    assertEquals(merge.verified, false);
    assertEquals(merge.actor, "unknown");
    assert(
      snapshot.coverageNotes.some((note) =>
        note.includes("failed verification")
      ),
    );
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 0);
  });
});

Deno.test("collect - no audit directory means the actions are not complete", async () => {
  const snapshot = await collectPrCompletionSnapshot(
    options(fakeGh(emptyFixture({ pulls: { [REPO]: [pull(1)] } }))),
  );
  assertEquals(
    snapshot.input.prs.every((pr) => pr.actionsComplete === false),
    true,
  );
  assert(
    snapshot.coverageNotes.includes("no audit directory supplied"),
  );
});

Deno.test("collect - an action repeated across two audit directories is counted once", async () => {
  await withDir(async (hostA) => {
    await withDir(async (hostB) => {
      const shared = {
        verb: "pr-merge",
        actionKind: "merge" as const,
        actionId: "dup-1",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T02:00:00Z",
      };
      await journal(hostA, [shared]);
      await journal(hostB, [shared]);
      const snapshot = await collectPrCompletionSnapshot(
        options(
          fakeGh(emptyFixture({ pulls: { [REPO]: [pull(1)] } })),
          { auditDirs: [hostA, hostB] },
        ),
      );
      assertEquals(
        snapshot.input.actions.filter((action) => action.actionId === "dup-1")
          .length,
        1,
      );
      assertEquals(snapshot.input.prs[0]!.actionsComplete, true);
    });
  });
});

Deno.test("collect - a CI run without a completion time has no duration", async () => {
  const fixture = emptyFixture({
    pulls: { [REPO]: [pull(1)] },
    checks: {
      sha1: {
        total_count: 3,
        check_runs: [
          {
            id: 11,
            status: "completed",
            started_at: "2026-10-20T00:00:00Z",
            completed_at: "2026-10-20T00:10:00Z",
          },
          {
            id: 12,
            status: "in_progress",
            started_at: "2026-10-20T00:00:00Z",
            completed_at: null,
          },
          {
            id: 13,
            status: "completed",
            started_at: "2026-10-20T00:00:00Z",
            completed_at: null,
          },
        ],
      },
    },
  });
  const snapshot = await collectPrCompletionSnapshot(options(fakeGh(fixture)));
  assertEquals(snapshot.input.ciRuns, [
    { repo: REPO, prNumber: 1, runId: "11", durationMinutes: 10 },
    { repo: REPO, prNumber: 1, runId: "12", durationMinutes: null },
    { repo: REPO, prNumber: 1, runId: "13", durationMinutes: null },
  ]);
});

Deno.test("collect - blocker intervals are closed or open as the events dictate", async () => {
  const fixture = emptyFixture({
    pulls: {
      [REPO]: [pull(1, {
        state: "open",
        merged_at: null,
        closed_at: null,
        labels: [{ name: "needs-human" }],
      })],
    },
    events: {
      [pk(1)]: [
        {
          id: 1,
          event: "labeled",
          label: { name: "needs-human" },
          created_at: "2026-10-20T10:00:00Z",
        },
        {
          id: 2,
          event: "unlabeled",
          label: { name: "needs-human" },
          created_at: "2026-10-20T12:00:00Z",
        },
        {
          id: 3,
          event: "labeled",
          label: { name: "needs-human" },
          created_at: "2026-10-20T14:00:00Z",
        },
      ],
    },
    reviews: {
      [pk(1)]: [
        {
          id: 9,
          state: "CHANGES_REQUESTED",
          submitted_at: "2026-10-20T15:00:00Z",
        },
        {
          id: 10,
          state: "CHANGES_REQUESTED",
          submitted_at: "2026-10-20T17:00:00Z",
        },
      ],
    },
    commits: { [pk(1)]: [commit("sha1", "2026-10-20T16:00:00Z")] },
  });
  const snapshot = await collectPrCompletionSnapshot(options(fakeGh(fixture)));
  assertEquals(snapshot.input.blockers, [
    {
      repo: REPO,
      prNumber: 1,
      blocker: "needs-human",
      startedAt: "2026-10-20T10:00:00Z",
      endedAt: "2026-10-20T12:00:00Z",
    },
    {
      repo: REPO,
      prNumber: 1,
      blocker: "needs-human",
      startedAt: "2026-10-20T14:00:00Z",
      endedAt: null,
    },
    {
      repo: REPO,
      prNumber: 1,
      blocker: "changes-requested",
      startedAt: "2026-10-20T15:00:00Z",
      endedAt: "2026-10-20T16:00:00Z",
    },
    {
      repo: REPO,
      prNumber: 1,
      blocker: "changes-requested",
      startedAt: "2026-10-20T17:00:00Z",
      endedAt: null,
    },
  ]);
  const report = buildPrCompletionReport(snapshot.input);
  assertEquals(report.waiting.openIntervals, 2);
});

Deno.test("collect - a revert of a merged cohort PR is a regression, including a hostile input (returns; a catastrophic pattern would hang)", async () => {
  const hostileTitle = `Revert "${"a".repeat(5_000)}" (#1)`;
  const hostileBody = `Reverts ${" ".repeat(30_000)}#${"9".repeat(3_000)}` +
    "(#".repeat(5_000);
  const fixture = emptyFixture({
    pulls: {
      [REPO]: [
        pull(1),
        pull(2, {
          title: 'Revert "Change 1 (#1)"',
          created_at: "2026-10-21T00:00:00Z",
          merged_at: "2026-10-21T01:00:00Z",
        }),
        pull(4, {
          title: hostileTitle,
          body: hostileBody,
          created_at: "2026-10-22T00:00:00Z",
          state: "open",
          merged_at: null,
          closed_at: null,
        }),
      ],
    },
  });
  const snapshot = await collectPrCompletionSnapshot(options(fakeGh(fixture)));
  assertEquals(snapshot.input.regressions, [{
    repo: REPO,
    prNumber: 1,
    detectedAt: "2026-10-21T00:00:00Z",
    resolved: true,
  }]);
});

Deno.test("collect - deployments come from all three sources and missing or malformed files are noted", async () => {
  await withDir(async (dir) => {
    const babysitter = `${dir}/babysitter`;
    const babysitterMissing = `${dir}/babysitter-missing`;
    const babysitterBad = `${dir}/babysitter-bad`;
    const rounds = `${dir}/rounds`;
    for (const d of [babysitter, babysitterMissing, babysitterBad, rounds]) {
      await Deno.mkdir(d, { recursive: true });
    }
    await Deno.writeTextFile(
      `${babysitter}/deployment-health.json`,
      JSON.stringify({
        component: "babysitter",
        codeRevision: "rev1",
        policyFingerprint: FP,
        observedAt: "2026-11-01T23:00:00Z",
      }),
    );
    await Deno.writeTextFile(
      `${babysitterBad}/deployment-health.json`,
      "{not json",
    );
    await Deno.mkdir(`${rounds}/20261101-100000`);
    await Deno.writeTextFile(
      `${rounds}/20261101-100000/review-run.json`,
      JSON.stringify({
        round: "20261101-100000",
        attempts: [],
        deployment: {
          component: "reviewer",
          codeRevision: "rev1",
          policyFingerprint: FP,
          observedAt: "2026-11-01T22:00:00Z",
        },
      }),
    );
    await Deno.mkdir(`${rounds}/20261101-110000`);
    await Deno.writeTextFile(
      `${rounds}/20261101-110000/review-run.json`,
      "{malformed",
    );
    await Deno.mkdir(`${rounds}/20261101-120000`);
    const ledger = `${dir}/ledger.jsonl`;
    const event = buildLifecycleEvent({
      kind: "assignment",
      assignmentId: "3f2c9a1e-4b5d-4c6e-8f70-1a2b3c4d5e01",
      runId: "run-1",
      host: "host-a",
      repo: REPO,
      issueNumber: 1,
      recordedAt: "2026-11-01T21:00:00Z",
      assignedAt: "2026-11-01T21:00:00Z",
      cohort: "control",
      reused: false,
      treatment: {
        roles: [{ role: "executor", provider: "claude" }],
        workerCommit: "rev1",
        reviewPolicyFingerprint: FP,
      },
    });
    await Deno.writeTextFile(ledger, serialiseLifecycleEvent(event) + "\n");

    const snapshot = await collectPrCompletionSnapshot(options(
      fakeGh(emptyFixture()),
      {
        babysitterStateDirs: [babysitter, babysitterMissing, babysitterBad],
        reviewRunDirs: [rounds],
        lifecycleLedgers: [ledger, `${dir}/absent.jsonl`],
        expected: {
          components: ["worker", "reviewer", "babysitter"],
          revision: "rev1",
          policyFingerprint: FP,
          maxHeartbeatAgeHours: 24,
        },
      },
    ));
    assertEquals(
      snapshot.input.deployments.map((row) => row.component).sort(),
      ["babysitter", "reviewer", "worker"],
    );
    const notes = snapshot.coverageNotes.join("\n");
    assertStringIncludes(
      notes,
      `${babysitterMissing}/deployment-health.json is missing`,
    );
    assertStringIncludes(
      notes,
      `${babysitterBad}/deployment-health.json is malformed JSON`,
    );
    assertStringIncludes(
      notes,
      "20261101-110000/review-run.json is malformed JSON",
    );
    assertStringIncludes(notes, "1 round(s) have no review-run.json");
    assertStringIncludes(notes, `${dir}/absent.jsonl is missing`);
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.deployment.status, "verified");
  });
});

Deno.test("collect - the rollout check counts stranded, rediscovered and processed PRs by verified time", async () => {
  await withDir(async (dir) => {
    await journal(dir, [
      // Before the rollout verification: must not count as rediscovery.
      {
        verb: "pr-review",
        actionKind: "review",
        actionId: "before-a",
        repo: REPO,
        prNumber: 1,
        component: "reviewer",
        timestamp: "2026-10-24T00:00:00Z",
      },
      // After the rollout verification, confirmed and processed.
      {
        verb: "pr-review",
        actionKind: "review",
        actionId: "after-b",
        repo: REPO,
        prNumber: 2,
        component: "reviewer",
        timestamp: "2026-10-26T00:00:00Z",
      },
      // After the rollout verification, but the action failed.
      {
        verb: "pr-review",
        actionKind: "review",
        actionId: "after-c",
        repo: REPO,
        prNumber: 3,
        component: "reviewer",
        outcome: "error",
        timestamp: "2026-10-26T00:00:00Z",
      },
    ]);
    const open = { state: "open", merged_at: null, closed_at: null };
    const fixture = emptyFixture({
      pulls: {
        [REPO]: [
          pull(4, { ...open, created_at: "2026-10-27T00:00:00Z" }),
          pull(3, { ...open, created_at: "2026-10-20T00:00:00Z" }),
          pull(2, { ...open, created_at: "2026-10-20T00:00:00Z" }),
          pull(1, { ...open, created_at: "2026-10-20T00:00:00Z" }),
          pull(5, {
            ...open,
            created_at: "2026-10-20T00:00:00Z",
            labels: [{ name: "needs-human" }],
          }),
        ],
      },
    });
    const snapshot = await collectPrCompletionSnapshot(options(
      fakeGh(fixture),
      {
        auditDirs: [dir],
        rolloutVerifiedAt: "2026-10-25T00:00:00Z",
      },
    ));
    const stranded = snapshot.input.rollout!.strandedPrs
      .map((pr) => ({
        prNumber: pr.prNumber,
        rediscovered: pr.rediscovered,
        processed: pr.processed,
      }))
      .sort((a, b) => a.prNumber - b.prNumber);
    assertEquals(stranded, [
      { prNumber: 1, rediscovered: false, processed: false },
      { prNumber: 2, rediscovered: true, processed: true },
      { prNumber: 3, rediscovered: true, processed: false },
    ]);
    assertEquals(snapshot.input.rollout!.verifiedAt, "2026-10-25T00:00:00Z");
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.rollout.eligibleStrandedPrs, 3);
    assertEquals(report.rollout.rediscoveredPrs, 2);
    assertEquals(report.rollout.processedPrs, 1);
    assertEquals(report.rollout.notRediscoveredPrs, 1);
  });
});

Deno.test("collect - a zero-PR cohort yields an empty, valid report", async () => {
  const snapshot = await collectPrCompletionSnapshot(options(
    fakeGh(emptyFixture({ pulls: { [REPO]: [] } })),
  ));
  assertEquals(snapshot.input.prs, []);
  assertEquals(snapshot.truncatedRepos, []);
  const report = buildPrCompletionReport(snapshot.input);
  assertEquals(report.cohort.prCount, 0);
  assertEquals(report.completion.unattendedWithin24Hours, null);
});
