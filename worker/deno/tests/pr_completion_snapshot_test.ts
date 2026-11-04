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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  _resetAuditCaches,
  auditFilePath,
  loadEntries,
  recordMutation,
} from "../lib/audit_journal.ts";
import { rosterPath } from "../lib/audit_anchor.ts";
import type { AuditMutation } from "../lib/audit_entry.ts";
import {
  actionKindFor,
  auditGhMutation,
  callerFromStack,
} from "../lib/audit_hook.ts";
import { appendPrDiscoveryEvent } from "../lib/pr_discovery_events.ts";
import { classifyGhMutation } from "../lib/audit_mutation_classifier.ts";
import { envFrom } from "./support/env_lookup.ts";
import {
  buildLifecycleEvent,
  serialiseLifecycleEvent,
} from "../lib/lifecycle_ledger.ts";
import {
  buildPrCompletionReport,
  type TrustedPrAction,
} from "../lib/pr_completion_report.ts";
import {
  type CollectedSnapshot,
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
const MINUTE = 60_000;
const HOUR = 3_600_000;

Deno.test("collect - failed merge attempts cannot match events but do not taint confirmed delivery", async () => {
  await withDir(async (dir) => {
    await journal(dir, [
      ...[1, 2].map((n) => ({
        verb: "git-push",
        actionKind: "implementation" as const,
        actionId: `push-${n}`,
        deliveredCommits: [`sha${n}`],
        target: `issue-${n}`,
        timestamp: "2026-10-20T00:30:00Z",
      })),
      ...[1, 2].map((n) => ({
        verb: "pr-merge",
        actionKind: "merge" as const,
        actionId: `failed-${n}`,
        repo: REPO,
        prNumber: n,
        outcome: "error" as const,
        timestamp: "2026-10-20T01:00:00Z",
      })),
      {
        verb: "pr-merge",
        actionKind: "merge",
        actionId: "direct",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T02:00:00Z",
      },
    ]);
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({
          pulls: { [REPO]: [pull(1), pull(2)] },
          commits: {
            [pk(1)]: [commit("sha1", "2026-10-20T00:25:00Z")],
            [pk(2)]: [commit("sha2", "2026-10-20T00:25:00Z")],
          },
        })),
        { auditDirs: [dir] },
      ),
    );
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 1);
    assertEquals(report.completion.unknownMerged, 1);
  });
});

Deno.test("collect - auto-merge arming cannot verify a later merge", async () => {
  await withDir(async (dir) => {
    const args = ["pr", "merge", "1", "--repo", REPO, "--auto"];
    const info = classifyGhMutation(args);
    assert(info);
    await journal(dir, [
      {
        verb: "git-push",
        actionKind: "implementation",
        actionId: "arm-case-push",
        deliveredCommits: ["sha1"],
        target: "issue-1",
        timestamp: "2026-10-20T00:30:00Z",
      },
      {
        verb: info.verb,
        actionKind: actionKindFor(info, undefined, args),
        actionId: "auto-merge-armed",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T01:00:00Z",
      },
    ]);
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({
          pulls: {
            [REPO]: [pull(1, { merged_at: "2026-10-22T02:00:00Z" })],
          },
          commits: {
            [pk(1)]: [commit("sha1", "2026-10-20T00:25:00Z")],
          },
        })),
        { auditDirs: [dir] },
      ),
    );
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 0);
    assertEquals(report.completion.unknownMerged, 1);
  });
});

Deno.test("collect - an auto-merge armed through the audit hook is journalled as merge-arm and never verifies a later merge", async () => {
  const workDir = await Deno.makeTempDir();
  try {
    const env = envFrom({
      WORK_DIR: workDir,
      WORKER_UNIQUE_ID: "test-worker",
      VIBE_RUN_ID: "run-arm-hook",
    });
    _resetAuditCaches();
    // A head pin (40-hex) is what the hook records as the entry's headSha, so a
    // misclassified arm would have a head to match the GitHub merge on.
    const head = "a".repeat(40);
    await auditGhMutation(
      [
        "pr",
        "merge",
        "1",
        "--repo",
        REPO,
        "--auto",
        "--match-head-commit",
        head,
      ],
      0,
      { env },
    );
    const written = await loadEntries(auditFilePath({ env }));
    assert(written.ok, written.ok ? "" : written.error.message);
    assertEquals(written.value.length, 1, "the hook journals one arm");
    const arm = written.value[0]!;
    assertEquals(arm.verb, "pr-merge");
    assertEquals(arm.actionKind, "merge-arm");
    assertEquals(arm.headSha, head);

    // Collect the hook's journal with a GitHub merge four minutes after the
    // arm, on the same head. The arm must not verify it.
    const armedMs = Date.parse(arm.timestamp);
    const iso = (ms: number) => new Date(ms).toISOString();
    const auditDir = `${workDir}/audit`;
    await journal(auditDir, [{
      verb: "git-push",
      actionKind: "implementation",
      actionId: "hook-arm-push",
      deliveredCommits: [head],
      target: "issue-1",
      timestamp: iso(armedMs - 30 * MINUTE),
    }]);
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({
          pulls: {
            [REPO]: [pull(1, {
              created_at: iso(armedMs - 2 * HOUR),
              merged_at: iso(armedMs + 4 * MINUTE),
              closed_at: iso(armedMs + 4 * MINUTE),
              head: { ref: "issue-1", sha: head },
            })],
          },
          commits: {
            [pk(1)]: [commit(head, iso(armedMs - 40 * MINUTE))],
          },
        })),
        {
          auditDirs: [auditDir],
          cohort: {
            start: iso(armedMs - 3 * HOUR),
            end: iso(armedMs + 3 * HOUR),
            observedAt: iso(armedMs + 4 * HOUR),
          },
        },
      ),
    );
    assertEquals(
      snapshot.input.actions.find((action) => action.actionId === arm.actionId)
        ?.kind,
      "merge-arm",
    );
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 0);
    assertEquals(report.completion.unknownMerged, 1);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("collect - a confirmed update-branch accounts for its GitHub commit without a fix round", async () => {
  await withDir(async (dir) => {
    const args = [
      "api",
      "--method",
      "PUT",
      `repos/${REPO}/pulls/1/update-branch`,
    ];
    const info = classifyGhMutation(args);
    assert(info);
    await journal(dir, [
      {
        verb: "git-push",
        actionKind: "implementation",
        actionId: "push",
        deliveredCommits: ["sha1"],
        target: "issue-1",
        timestamp: "2026-10-20T00:30:00Z",
      },
      {
        verb: info.verb,
        actionKind: actionKindFor(info, undefined, args),
        actionId: "update",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T01:30:00Z",
      },
      {
        verb: "pr-merge",
        actionKind: "merge",
        actionId: "merge",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T02:00:00Z",
      },
    ]);
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({
          pulls: { [REPO]: [pull(1)] },
          commits: {
            [pk(1)]: [
              commit("sha1", "2026-10-20T00:25:00Z"),
              commit("update", "2026-10-20T01:30:02Z"),
            ],
          },
        })),
        { auditDirs: [dir] },
      ),
    );
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 1);
    assertEquals(report.delivery.fixRounds, 0);
    for (const manualAt of ["01:00:00", "01:30:03"]) {
      const manual = await collectPrCompletionSnapshot(options(
        fakeGh(emptyFixture({
          pulls: { [REPO]: [pull(1)] },
          commits: {
            [pk(1)]: [
              commit("sha1", "2026-10-20T00:25:00Z"),
              ...(manualAt === "01:00:00"
                ? [commit("manual", `2026-10-20T${manualAt}Z`)]
                : []),
              commit("update", "2026-10-20T01:30:02Z"),
              ...(manualAt === "01:30:03"
                ? [commit("manual", `2026-10-20T${manualAt}Z`)]
                : []),
            ],
          },
        })),
        { auditDirs: [dir] },
      ));
      assert(
        manual.input.actions.some((a) =>
          a.actor === "unknown" && a.actionId.endsWith(":manual")
        ),
      );
      const manualReport = buildPrCompletionReport(manual.input);
      assertEquals(manualReport.completion.unattendedMerged, 0);
      assertEquals(manualReport.completion.unknownMerged, 1);
    }
  });
});

Deno.test("collect - a failed review cannot account for a GitHub approval", async () => {
  await withDir(async (dir) => {
    await journal(dir, [
      {
        verb: "git-push",
        actionKind: "implementation",
        actionId: "push",
        target: "issue-1",
        timestamp: "2026-10-20T00:30:00Z",
      },
      {
        verb: "pr-review",
        actionKind: "review",
        actionId: "failed-review",
        repo: REPO,
        prNumber: 1,
        outcome: "error",
        timestamp: "2026-10-20T01:00:00Z",
      },
      {
        verb: "pr-merge",
        actionKind: "merge",
        actionId: "merge",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T02:00:00Z",
      },
    ]);
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({
          pulls: { [REPO]: [pull(1)] },
          commits: { [pk(1)]: [commit("sha1", "2026-10-20T00:25:00Z")] },
          reviews: { [pk(1)]: [review(601, "2026-10-20T01:00:00Z")] },
        })),
        { auditDirs: [dir] },
      ),
    );
    assert(
      snapshot.input.actions.some((a) =>
        a.kind === "review" && a.actor === "unknown"
      ),
    );
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unknownMerged, 1);
    assertEquals(report.completion.unattendedMerged, 0);
    assertEquals(report.delivery.reviewRounds, 0);
  });
});

Deno.test("collect - a journalled review without a head SHA matches the GitHub review that carries a commit_id", async () => {
  await withDir(async (dir) => {
    await journal(dir, [
      {
        verb: "git-push",
        actionKind: "implementation",
        actionId: "a-push-review-head",
        deliveredCommits: ["sha1"],
        target: "issue-1",
        timestamp: "2026-10-20T00:30:00Z",
      },
      // Production-shaped: gh pr review journals no headSha.
      {
        verb: "pr-review",
        actionKind: "review",
        actionId: "a-review-head",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T00:59:00Z",
      },
      {
        verb: "pr-merge",
        actionKind: "merge",
        actionId: "a-merge-review-head",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T02:00:00Z",
      },
    ]);
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({
          pulls: { [REPO]: [pull(1)] },
          reviews: { [pk(1)]: [review(601, REVIEW_AT)] },
          commits: { [pk(1)]: [commit("sha1", "2026-10-20T00:25:00Z")] },
        })),
        { auditDirs: [dir] },
      ),
    );
    const journalled = snapshot.input.actions.find((action) =>
      action.actionId === "a-review-head"
    );
    assertEquals(
      journalled?.githubEvents,
      [{ kind: "review", id: "601", headSha: "sha1" }],
      "the journalled review must account for the GitHub review",
    );
    assertEquals(
      snapshot.input.actions.some((action) =>
        action.actionId === "gh:org/repo#1:review:601"
      ),
      false,
      "the GitHub review must not stay an unknown action",
    );
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 1);
    assertEquals(report.completion.unknownMerged, 0);
  });
});

Deno.test("collect - a rejected repair push followed by recovery is one confirmed fix round", async () => {
  await withDir(async (dir) => {
    const caller = callerFromStack([
      "    at auditGitMutation (file:///srv/VibeCoder/worker/deno/lib/audit_hook.ts:308:3)",
      "    at runGitCommand (file:///srv/VibeCoder/worker/deno/lib/git_timeout.ts:366:5)",
      "    at recoverFromPushRejection (file:///srv/VibeCoder/worker/deno/lib/git_push_recovery.ts:300:5)",
      "    at pushUnpushedCommits (file:///srv/VibeCoder/worker/deno/lib/git_push.ts:400:5)",
      "    at finalise (file:///srv/VibeCoder/worker/deno/lib/pr_feedback_processor.ts:1684:7)",
    ].join("\n"));
    const kind = actionKindFor(
      { verb: "git-push", target: "issue-1", scope: "cwd" },
      caller,
      ["push", "origin", "issue-1"],
    );
    await journal(dir, [
      {
        verb: "git-push",
        actionKind: "repair",
        actionId: "rejected",
        target: "issue-1",
        outcome: "error",
        timestamp: "2026-10-20T00:29:00Z",
      },
      {
        verb: "git-push",
        actionKind: kind,
        actionId: "retry",
        deliveredCommits: ["sha1"],
        caller,
        target: "issue-1",
        timestamp: "2026-10-20T00:30:00Z",
      },
      {
        verb: "pr-merge",
        actionKind: "merge",
        actionId: "merge",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T02:00:00Z",
      },
    ]);
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({
          pulls: { [REPO]: [pull(1)] },
          commits: { [pk(1)]: [commit("sha1", "2026-10-20T00:25:00Z")] },
        })),
        { auditDirs: [dir] },
      ),
    );
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 1);
    assertEquals(report.completion.unknownMerged, 0);
    assertEquals(report.delivery.fixRounds, 1);
  });
});

Deno.test("collect - pre-PR checkpoints and delayed completion deliver all commits", async () => {
  await withDir(async (dir) => {
    await journal(dir, [
      ...[20, 30, 52].map((minute) => ({
        verb: "git-push",
        actionKind: "implementation" as const,
        actionId: `push-${minute}`,
        deliveredCommits: minute === 20
          ? ["sha-10", "sha-20"]
          : minute === 30
          ? ["sha-30"]
          : ["sha-40"],
        target: "issue-1",
        timestamp: `2026-10-20T00:${minute}:00Z`,
      })),
      {
        verb: "pr-merge",
        actionKind: "merge",
        actionId: "merge-1",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T02:00:00Z",
      },
    ]);
    const fixture = emptyFixture({
      pulls: { [REPO]: [pull(1, { created_at: "2026-10-20T00:53:00Z" })] },
      commits: {
        [pk(1)]: [10, 20, 30, 40].map((minute) =>
          commit(`sha-${minute}`, `2026-10-20T00:${minute}:00Z`)
        ),
      },
    });
    const snapshot = await collectPrCompletionSnapshot(
      options(fakeGh(fixture), { auditDirs: [dir] }),
    );
    assertEquals(
      buildPrCompletionReport(snapshot.input).completion.unattendedMerged,
      1,
    );
    for (const id of ["push-20", "push-30"]) {
      assertEquals(
        snapshot.input.actions.find((a) => a.actionId === id)?.prNumber,
        1,
      );
    }
    assertEquals(
      snapshot.input.actions.filter((a) => a.actor === "unknown"),
      [],
    );
  });
});

Deno.test("collect - all pushes may precede PR creation by more than ten minutes", async () => {
  await withDir(async (dir) => {
    await journal(dir, [
      ...[20, 40].map((minute) => ({
        verb: "git-push",
        actionKind: "implementation" as const,
        actionId: `early-push-${minute}`,
        deliveredCommits: [minute === 20 ? "sha-10" : "sha-30"],
        target: "issue-1",
        timestamp: `2026-10-20T00:${minute}:00Z`,
      })),
      {
        verb: "pr-merge",
        actionKind: "merge",
        actionId: "merge-1",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T02:00:00Z",
      },
    ]);
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({
          pulls: { [REPO]: [pull(1, { created_at: "2026-10-20T01:05:00Z" })] },
          commits: {
            [pk(1)]: [10, 30].map((minute) =>
              commit(`sha-${minute}`, `2026-10-20T00:${minute}:00Z`)
            ),
          },
        })),
        { auditDirs: [dir] },
      ),
    );
    assertEquals(
      buildPrCompletionReport(snapshot.input).completion.unattendedMerged,
      1,
    );
    assertEquals(
      snapshot.input.actions.filter((a) => a.actor === "unknown"),
      [],
    );
  });
});

Deno.test("collect - a journalled disarm cannot account for a GitHub merge", async () => {
  await withDir(async (dir) => {
    const args = ["pr", "merge", "1", "--repo", REPO, "--disable-auto"];
    const info = classifyGhMutation(args);
    assert(info);
    await journal(dir, [
      {
        verb: "git-push",
        actionKind: "implementation",
        actionId: "push-1",
        deliveredCommits: ["sha1"],
        target: "issue-1",
        timestamp: "2026-10-20T01:00:00Z",
      },
      {
        verb: info.verb,
        actionKind: actionKindFor(info, undefined, args),
        actionId: "disarm-1",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T01:30:00Z",
      },
      {
        verb: "pr-merge",
        actionKind: "merge",
        actionId: "earlier-arm",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T01:15:00Z",
      },
    ]);
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({
          pulls: { [REPO]: [pull(1)] },
          commits: { [pk(1)]: [commit("sha1", "2026-10-20T00:30:00Z")] },
        })),
        { auditDirs: [dir] },
      ),
    );
    assert(
      snapshot.input.actions.some((a) =>
        a.kind === "merge" && a.actor === "unknown"
      ),
    );
    assertEquals(
      buildPrCompletionReport(snapshot.input).completion.unattendedMerged,
      0,
    );
  });
});

Deno.test("collect - later fleet repair cannot absorb an earlier owner commit", async () => {
  await withDir(async (dir) => {
    await journal(dir, [
      {
        verb: "git-push",
        actionKind: "implementation",
        actionId: "initial",
        target: "issue-1",
        timestamp: "2026-10-20T00:30:00Z",
        deliveredCommits: ["initial"],
      },
      {
        verb: "git-push",
        actionKind: "repair",
        actionId: "repair",
        target: "issue-1",
        timestamp: "2026-10-20T01:20:00Z",
        deliveredCommits: ["repair"],
      },
      {
        verb: "pr-merge",
        actionKind: "merge",
        actionId: "merge",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T02:00:00Z",
      },
    ]);
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({
          pulls: { [REPO]: [pull(1)] },
          commits: {
            [pk(1)]: [
              commit("initial", "2026-10-20T00:25:00Z"),
              commit("owner", "2026-10-20T01:00:00Z"),
              commit("repair", "2026-10-20T01:15:00Z"),
            ],
          },
        })),
        { auditDirs: [dir] },
      ),
    );
    assert(
      snapshot.input.actions.some((a) =>
        a.actor === "unknown" && a.actionId.endsWith(":owner")
      ),
    );
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 0);
    assertEquals(report.completion.unknownMerged, 1);
  });
});

Deno.test("collect - an edited non-audit JSONL is never chain verified", async () => {
  await withDir(async (dir) => {
    await journal(dir, [{
      verb: "pr-merge",
      actionKind: "merge",
      actionId: "valid",
      repo: REPO,
      prNumber: 1,
      timestamp: "2026-10-20T02:00:00Z",
    }]);
    const path = auditFilePath({
      baseDir: dir,
      workerId: "test-worker",
      date: JOURNAL_DATE,
    });
    await Deno.writeTextFile(
      `${dir}/other.jsonl`,
      (await Deno.readTextFile(path)).replace('"valid"', '"edited"'),
    );
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({
          pulls: { [REPO]: [pull(1)] },
        })),
        { auditDirs: [dir] },
      ),
    );
    assertEquals(
      snapshot.input.actions.find((a) => a.actionId === "edited")?.verified,
      false,
    );
    assertEquals(snapshot.input.prs[0]!.actionsComplete, false);
    assert(
      snapshot.coverageNotes.some((note) =>
        note.includes("other.jsonl") && note.includes("unverified")
      ),
    );
    assertEquals(
      buildPrCompletionReport(snapshot.input).completion.unattendedMerged,
      0,
    );
  });
});

Deno.test("collect - legacy push records cannot prove commit delivery", async () => {
  await withDir(async (dir) => {
    await journal(dir, [
      {
        verb: "git-push",
        actionKind: "implementation",
        actionId: "legacy-push",
        target: "issue-1",
        timestamp: "2026-10-20T00:30:00Z",
      },
      {
        verb: "pr-merge",
        actionKind: "merge",
        actionId: "merge",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T02:00:00Z",
      },
    ]);
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({
          pulls: { [REPO]: [pull(1)] },
          commits: { [pk(1)]: [commit("sha1", "2026-10-20T00:25:00Z")] },
        })),
        { auditDirs: [dir] },
      ),
    );
    assert(
      snapshot.input.actions.some((a) =>
        a.actor === "unknown" && a.actionId.endsWith(":sha1")
      ),
    );
    assertEquals(
      buildPrCompletionReport(snapshot.input).completion.unattendedMerged,
      0,
    );
  });
});

Deno.test("collect - auto-merge arms and withdrawals never verify a GitHub merge", async () => {
  for (const failed of [false, true]) {
    await withDir(async (dir) => {
      await journal(dir, [
        {
          verb: "git-push",
          actionKind: "implementation",
          actionId: "push",
          target: "issue-1",
          deliveredCommits: ["sha1"],
          timestamp: "2026-10-20T00:30:00Z",
        },
        {
          verb: "pr-merge",
          actionKind: "merge-arm",
          actionId: "arm",
          repo: REPO,
          prNumber: 1,
          timestamp: "2026-10-20T01:00:00Z",
        },
        {
          verb: "pr-merge",
          actionKind: "unknown",
          actionId: "disarm",
          repo: REPO,
          prNumber: 1,
          outcome: failed ? "error" : "success",
          timestamp: "2026-10-20T01:15:00Z",
        },
        ...(!failed
          ? [{
            verb: "pr-merge",
            actionKind: "merge-arm" as const,
            actionId: "rearm",
            repo: REPO,
            prNumber: 1,
            timestamp: "2026-10-20T01:30:00Z",
          }]
          : []),
      ]);
      const snapshot = await collectPrCompletionSnapshot(
        options(
          fakeGh(emptyFixture({
            pulls: { [REPO]: [pull(1)] },
            commits: { [pk(1)]: [commit("sha1", "2026-10-20T00:25:00Z")] },
          })),
          { auditDirs: [dir] },
        ),
      );
      assertEquals(
        buildPrCompletionReport(snapshot.input).completion.unknownMerged,
        1,
      );
    });
  }
});

interface Fixture {
  pulls?: Record<string, Json[]>;
  reviews?: Record<string, Json[]>;
  events?: Record<string, Json[]>;
  commits?: Record<string, Json[]>;
  checks?: Record<string, Json>;
  workflowRuns?: Record<string, Json>;
  workflowAttempts?: Record<string, Json>;
  jobs?: Record<string, Json>;
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
    if ((match = /^repos\/[^/]+\/[^/]+\/actions\/runs$/.exec(base!))) {
      const headSha = params.get("head_sha") ?? "";
      return fixture.workflowRuns?.[headSha] ??
        { total_count: 0, workflow_runs: [] };
    }
    if (
      (match = /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/attempts\/(\d+)$/
        .exec(
          base!,
        ))
    ) {
      const key = `${match[1]}:${match[2]}`;
      const run = fixture.workflowAttempts?.[key];
      if (!run) throw new Error(`missing workflow attempt fixture: ${key}`);
      return run;
    }
    if (
      (match =
        /^repos\/[^/]+\/[^/]+\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs$/
          .exec(
            base!,
          ))
    ) {
      return fixture.jobs?.[`${match[1]}:${match[2]}`] ?? {
        total_count: 0,
        jobs: [],
      };
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
    const withHead =
      entry.verb === "pr-merge" && entry.actionKind === "merge" &&
        entry.headSha === undefined && entry.prNumber !== undefined
        ? { ...entry, headSha: `sha${entry.prNumber}` }
        : entry;
    const result = await recordMutation({
      runId: "run-1",
      outcome: "success",
      component: "worker",
      ...withHead,
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

Deno.test("collect - audit verification leaves interrupted history untouched", async () => {
  await withDir(async (dir) => {
    await journal(dir, [{ verb: "issue-comment", actionId: "recorded" }]);
    const path = auditFilePath({
      baseDir: dir,
      workerId: "test-worker",
      date: JOURNAL_DATE,
    });
    const original = await Deno.readTextFile(path);
    await Deno.writeTextFile(path, `${original}{\"torn\":`);
    const before = await Deno.readTextFile(path);

    const snapshot = await collectPrCompletionSnapshot(
      options(fakeGh(emptyFixture()), { auditDirs: [dir] }),
    );

    assertEquals(await Deno.readTextFile(path), before);
    assert(
      snapshot.coverageNotes.some((note) =>
        note.includes("failed verification")
      ),
      "a broken journal remains visible in coverage",
    );
  });
});

Deno.test("collect - a damaged audit roster is reported and left untouched, because collection never repairs it", async () => {
  await withDir(async (dir) => {
    // The roster sits beside the audit directory, so both live under `dir`.
    const auditDir = `${dir}/audit`;
    await journal(auditDir, [{ verb: "issue-comment", actionId: "recorded" }]);
    // Only the roster is damaged: its final line is an interrupted append.
    await Deno.writeTextFile(rosterPath(auditDir), '{"journal":', {
      append: true,
    });
    const rosterBefore = await Deno.readTextFile(rosterPath(auditDir));
    const journalPath = auditFilePath({
      baseDir: auditDir,
      workerId: "test-worker",
      date: JOURNAL_DATE,
    });
    const journalBefore = await Deno.readTextFile(journalPath);

    const snapshot = await collectPrCompletionSnapshot(
      options(fakeGh(emptyFixture()), { auditDirs: [auditDir] }),
    );

    assertEquals(
      await Deno.readTextFile(rosterPath(auditDir)),
      rosterBefore,
      "collection must not repair the roster",
    );
    assertEquals(await Deno.readTextFile(journalPath), journalBefore);
    assert(
      snapshot.coverageNotes.some((note) =>
        note.includes("chain sweep failed")
      ),
      "a damaged roster must stay visible in coverage",
    );
  });
});

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
  assertEquals(truncated.input.truncatedRepos, [REPO]);
  assert(!capped.calls.some((path) => path.includes("page=2")));

  // The truncation survives into the report, so it reaches --input replay.
  const report = buildPrCompletionReport(truncated.input);
  assertEquals(report.coverage.truncatedRepos, [REPO]);
  assertEquals(
    buildPrCompletionReport(snapshot.input).coverage.truncatedRepos,
    [],
  );
});

Deno.test("collect - a GitHub merge matched to a verified fleet action is unattended", async () => {
  await withDir(async (dir) => {
    await journal(dir, [
      {
        verb: "git-push",
        actionKind: "implementation",
        actionId: "a-push-1",
        deliveredCommits: ["sha1"],
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
      snapshot.input.actions.find((action) => action.actionId === "a-merge-1")
        ?.githubEvents,
      [{ kind: "merge", id: "merge1", headSha: "sha1" }],
    );
    assertEquals(
      snapshot.input.actions.find((action) => action.actionId === "a-push-1")
        ?.githubEvents,
      [{ kind: "implementation", id: "sha1" }],
    );
    assertEquals(
      snapshot.input.actions.filter((action) => action.actor === "unknown")
        .length,
      0,
    );
  });
});

Deno.test("collect - a verified merge matches GitHub's merge only on the same head and within ten minutes either side", async () => {
  // GitHub merges at 02:00. The window is symmetric, and the head must match.
  const cases: Array<
    { name: string; at: string; headSha?: string; matches: boolean }
  > = [
    { name: "11 minutes before", at: "2026-10-20T01:49:00Z", matches: false },
    { name: "9 minutes before", at: "2026-10-20T01:51:00Z", matches: true },
    { name: "11 minutes after", at: "2026-10-20T02:11:00Z", matches: false },
    { name: "9 minutes after", at: "2026-10-20T02:09:00Z", matches: true },
    {
      name: "on another head, 1 minute before",
      at: "2026-10-20T01:59:00Z",
      headSha: "other-head",
      matches: false,
    },
  ];
  for (const c of cases) {
    await withDir(async (dir) => {
      await journal(dir, [
        {
          verb: "git-push",
          actionKind: "implementation",
          actionId: "window-push",
          deliveredCommits: ["sha1"],
          target: "issue-1",
          timestamp: "2026-10-20T00:30:00Z",
        },
        {
          verb: "pr-merge",
          actionKind: "merge",
          actionId: "window-merge",
          repo: REPO,
          prNumber: 1,
          timestamp: c.at,
          ...(c.headSha ? { headSha: c.headSha } : {}),
        },
      ]);
      const snapshot = await collectPrCompletionSnapshot(
        options(
          fakeGh(emptyFixture({
            pulls: { [REPO]: [pull(1)] },
            commits: { [pk(1)]: [commit("sha1", "2026-10-20T00:25:00Z")] },
          })),
          { auditDirs: [dir] },
        ),
      );
      const report = buildPrCompletionReport(snapshot.input);
      assertEquals(
        report.completion.unattendedMerged,
        c.matches ? 1 : 0,
        `${c.name}: unattended`,
      );
      assertEquals(
        report.completion.unknownMerged,
        c.matches ? 0 : 1,
        `${c.name}: unknown`,
      );
      assertEquals(
        snapshot.input.actions.find((action) =>
          action.actionId === "window-merge"
        )?.githubEvents?.length ?? 0,
        c.matches ? 1 : 0,
        `${c.name}: matched GitHub events`,
      );
    });
  }
});

Deno.test("collect - a pre-change merge entry with no headSha is read as unknown, so its PR is not unattended", async () => {
  await withDir(async (dir) => {
    await journal(dir, [{
      verb: "git-push",
      actionKind: "implementation",
      actionId: "old-push",
      deliveredCommits: ["sha1"],
      target: "issue-1",
      timestamp: "2026-10-20T00:30:00Z",
    }]);
    // journal() defaults a headSha onto merge entries, and pre-change merge
    // entries never carried one. This entry is written directly, without it.
    const written = await recordMutation({
      runId: "run-1",
      outcome: "success",
      component: "worker",
      actionId: "old-merge",
      actionKind: "merge",
      verb: "pr-merge",
      repo: REPO,
      prNumber: 1,
      timestamp: "2026-10-20T02:00:00Z",
    }, { baseDir: dir, workerId: "test-worker", date: JOURNAL_DATE });
    assert(written.ok, written.ok ? "" : written.error.message);
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({
          pulls: { [REPO]: [pull(1)] },
          commits: { [pk(1)]: [commit("sha1", "2026-10-20T00:25:00Z")] },
        })),
        { auditDirs: [dir] },
      ),
    );
    assertEquals(
      snapshot.input.actions.find((action) => action.actionId === "old-merge")
        ?.headSha,
      undefined,
    );
    assert(
      snapshot.input.actions.some((action) =>
        action.actionId === "gh:org/repo#1:merge:merge1" &&
        action.actor === "unknown"
      ),
      "the GitHub merge must stay an unknown action",
    );
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 0);
    assertEquals(report.completion.unknownMerged, 1);
  });
});

Deno.test("collect - milestone rollup actions link the delivered GitHub commit", async () => {
  await withDir(async (dir) => {
    await journal(dir, [
      {
        verb: "git-push",
        actionKind: "milestone",
        actionId: "milestone-push-1",
        repo: REPO,
        prNumber: 1,
        headSha: "sha1",
        deliveredCommits: ["sha1"],
        target: "milestone/release",
        timestamp: "2026-10-20T00:30:00Z",
      },
      {
        verb: "pr-merge",
        actionKind: "merge",
        actionId: "milestone-merge-1",
        repo: REPO,
        prNumber: 1,
        headSha: "sha1",
        timestamp: "2026-10-20T01:59:00Z",
      },
    ]);
    const fixture = emptyFixture({
      pulls: {
        [REPO]: [pull(1, { head: { ref: "milestone/release", sha: "sha1" } })],
      },
      commits: { [pk(1)]: [commit("sha1", "2026-10-20T00:25:00Z")] },
    });
    const snapshot = await collectPrCompletionSnapshot(
      options(fakeGh(fixture), { auditDirs: [dir] }),
    );
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 1);
    assertEquals(report.delivery.defaultBranchChanges, 1);
    assertEquals(
      snapshot.input.actions.find((action) =>
        action.actionId === "milestone-push-1"
      )
        ?.githubEvents,
      [{ kind: "implementation", id: "sha1" }],
    );
  });
});

Deno.test("collect - a repo-less branch push is linked to its PR by branch name", async () => {
  await withDir(async (dir) => {
    // Production writes git-push entries without a repo: only the target.
    await journal(dir, [{
      verb: "git-push",
      actionKind: "implementation",
      actionId: "a-push-5",
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
    assertEquals(push.repo, REPO);
    assertEquals(push.prNumber, 5);
    assertEquals(push.actor, "fleet");
    assertEquals(push.verified, true);
  });
});

/**
 * Journal one fleet push with the given fields, collect it against the given
 * GitHub pulls, and return the PR action it became, or `undefined` if the push
 * stayed unlinked.
 */
async function collectedPush(
  entry: Partial<AuditMutation>,
  pulls: Record<string, Json[]>,
): Promise<TrustedPrAction | undefined> {
  const dir = await Deno.makeTempDir();
  try {
    await journal(dir, [{
      verb: "git-push",
      actionKind: "implementation",
      actionId: "push-under-test",
      timestamp: "2026-10-20T00:30:00Z",
      ...entry,
    }]);
    const snapshot = await collectPrCompletionSnapshot(
      options(fakeGh(emptyFixture({ pulls })), {
        repos: Object.keys(pulls),
        auditDirs: [dir],
      }),
    );
    return snapshot.input.actions.find((action) =>
      action.actionId === "push-under-test"
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("collect - a repo-less push whose branch belongs to two repos stays unlinked", async () => {
  const pushed = await collectedPush(
    { target: "issue-8" },
    {
      [REPO]: [pull(8, { head: { ref: "issue-8", sha: "sha8" } })],
      "org/other": [pull(8, { head: { ref: "issue-8", sha: "sha8b" } })],
    },
  );
  assertEquals(pushed, undefined, "an ambiguous branch must not be linked");
});

Deno.test("collect - a HEAD push cannot be linked, even to a PR whose head is named HEAD", async () => {
  const pushed = await collectedPush(
    { target: "HEAD" },
    { [REPO]: [pull(9, { head: { ref: "HEAD", sha: "sha9" } })] },
  );
  assertEquals(pushed, undefined, "HEAD names no branch the journal records");
});

Deno.test("collect - a refspec push links by the branch after the colon", async () => {
  const pushed = await collectedPush(
    { target: "HEAD:refs/heads/issue-10" },
    { [REPO]: [pull(10)] },
  );
  assert(pushed, "the refspec destination names the PR's branch");
  assertEquals(pushed.repo, REPO);
  assertEquals(pushed.prNumber, 10);
});

Deno.test("collect - a push with a repo links within that repo only", async () => {
  await withDir(async (dir) => {
    await journal(dir, [{
      verb: "git-push",
      actionKind: "implementation",
      actionId: "push-with-repo",
      repo: "org/other",
      target: "issue-11",
      timestamp: "2026-10-20T00:30:00Z",
    }]);
    const snapshot = await collectPrCompletionSnapshot(
      options(
        fakeGh(emptyFixture({
          pulls: { [REPO]: [pull(11)], "org/other": [] },
        })),
        { repos: [REPO, "org/other"], auditDirs: [dir] },
      ),
    );
    assertEquals(
      snapshot.input.actions.some((action) =>
        action.actionId === "push-with-repo"
      ),
      false,
      "a push to org/other cannot link to a PR in org/repo",
    );
  });
});

Deno.test("collect - a push outside the PR's lifetime stays unlinked", async () => {
  // The PR is open from 2026-10-20 and observed at the cohort end: a push a
  // week before it was created cannot belong to it.
  const pushed = await collectedPush(
    { target: "issue-12", timestamp: "2026-10-10T00:00:00Z" },
    { [REPO]: [pull(12, { state: "open", merged_at: null, closed_at: null })] },
  );
  assertEquals(pushed, undefined);
});

Deno.test("collect - a push before a commit cannot have delivered it", async () => {
  await withDir(async (dir) => {
    await journal(dir, [{
      verb: "git-push",
      actionKind: "implementation",
      actionId: "a-push-6",
      target: "issue-6",
      timestamp: "2026-10-20T00:15:00Z",
    }]);
    const fixture = emptyFixture({
      pulls: {
        [REPO]: [pull(6, { merged_at: null, state: "open", closed_at: null })],
      },
      commits: { [pk(6)]: [commit("sha6", "2026-10-20T00:30:00Z")] },
    });
    const snapshot = await collectPrCompletionSnapshot(
      options(fakeGh(fixture), { auditDirs: [dir] }),
    );
    assert(
      snapshot.input.actions.some((action) =>
        action.actionId === "gh:org/repo#6:implementation:sha6" &&
        action.actor === "unknown" && action.verified === false
      ),
      "a push before the commit must leave its delivery unknown",
    );
  });
});

Deno.test("collect - an auto-merge arm never matches an asynchronous GitHub merge", async () => {
  await withDir(async (dir) => {
    // Auto-merge is armed (and journalled) long before GitHub merges the PR.
    await journal(dir, [
      {
        verb: "pr-merge",
        actionKind: "merge-arm",
        actionId: "armed-13",
        repo: REPO,
        prNumber: 13,
        timestamp: "2026-10-19T23:00:00Z",
      },
      {
        verb: "pr-merge",
        actionKind: "merge-arm",
        actionId: "armed-14",
        repo: REPO,
        prNumber: 14,
        timestamp: "2026-10-19T20:00:00Z",
      },
      {
        verb: "pr-merge",
        actionKind: "merge-arm",
        actionId: "late-15",
        repo: REPO,
        prNumber: 15,
        timestamp: "2026-10-20T02:15:00Z",
      },
    ]);
    // PR 14 was armed before it existed; PRs 13 and 15 existed since 19 Oct.
    const fixture = emptyFixture({
      pulls: {
        [REPO]: [
          pull(13, { created_at: "2026-10-19T12:00:00Z" }),
          pull(14, { created_at: "2026-10-20T00:00:00Z" }),
          pull(15, { created_at: "2026-10-19T12:00:00Z" }),
        ],
      },
    });
    const snapshot = await collectPrCompletionSnapshot(
      options(fakeGh(fixture), { auditDirs: [dir] }),
    );
    const ids = snapshot.input.actions.map((action) => action.actionId);
    assert(ids.includes("gh:org/repo#13:merge:merge13"));
    assert(ids.includes("gh:org/repo#14:merge:merge14"));
    assert(ids.includes("gh:org/repo#15:merge:merge15"));
    const armed13 = snapshot.input.actions.find((action) =>
      action.actionId === "armed-13"
    );
    assertEquals(armed13?.actor, "fleet");
    assertEquals(armed13?.kind, "merge-arm");
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
    {
      repo: REPO,
      prNumber: 1,
      runId: "11",
      durationMinutes: 10,
      kind: "check_run",
      headSha: "sha1",
      durationSeconds: 600,
      outcome: null,
      startedAt: "2026-10-20T00:00:00Z",
      completedAt: "2026-10-20T00:10:00Z",
    },
    {
      repo: REPO,
      prNumber: 1,
      runId: "12",
      durationMinutes: null,
      kind: "check_run",
      headSha: "sha1",
      durationSeconds: null,
      outcome: null,
      startedAt: "2026-10-20T00:00:00Z",
      completedAt: null,
    },
    {
      repo: REPO,
      prNumber: 1,
      runId: "13",
      durationMinutes: null,
      kind: "check_run",
      headSha: "sha1",
      durationSeconds: null,
      outcome: null,
      startedAt: "2026-10-20T00:00:00Z",
      completedAt: null,
    },
  ]);
});

Deno.test("collect - CI history includes observed heads, workflow attempts and paged jobs", async () => {
  const fixture = emptyFixture({
    pulls: { [REPO]: [pull(1, { merged_at: "2026-10-20T00:45:00Z" })] },
    commits: { [pk(1)]: [commit("sha2", "2026-10-20T00:40:00Z")] },
    workflowRuns: {
      sha1: {
        total_count: 1,
        workflow_runs: [{ id: 55, run_attempt: 2, workflow_id: 9 }],
      },
      sha2: { total_count: 0, workflow_runs: [] },
      // The merge commit (merge1): its failure after the merge is the one
      // post-merge regression, and its later attempt resolves it.
      merge1: {
        total_count: 1,
        workflow_runs: [{ id: 77, run_attempt: 2, workflow_id: 9 }],
      },
    },
    workflowAttempts: {
      "77:1": {
        id: 77,
        workflow_id: 9,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        run_started_at: "2026-10-20T00:40:00Z",
        updated_at: "2026-10-20T00:50:00Z",
      },
      "77:2": {
        id: 77,
        workflow_id: 9,
        run_attempt: 2,
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-10-20T00:55:00Z",
        updated_at: "2026-10-20T01:00:00Z",
      },
      "55:1": {
        id: 55,
        workflow_id: 9,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        run_started_at: "2026-10-20T00:00:00Z",
        updated_at: "2026-10-20T00:05:00Z",
      },
      "55:2": {
        id: 55,
        workflow_id: 9,
        run_attempt: 2,
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-10-20T00:10:00Z",
        updated_at: "2026-10-20T00:20:00Z",
      },
    },
    jobs: {
      "55:1": {
        total_count: 1,
        jobs: [{
          id: 551,
          status: "completed",
          conclusion: "failure",
          started_at: "2026-10-20T00:00:00Z",
          completed_at: "2026-10-20T00:04:00Z",
        }],
      },
      "55:2": {
        total_count: 1,
        jobs: [{
          id: 552,
          status: "completed",
          conclusion: "success",
          started_at: "2026-10-20T00:10:00Z",
          completed_at: "2026-10-20T00:18:00Z",
        }],
      },
    },
  });
  const snapshot = await collectPrCompletionSnapshot(options(fakeGh(fixture)));
  assertEquals(
    snapshot.input.ciRuns.filter((run) => run.kind === "workflow_run").map(
      (run) => [run.headSha, run.attempt, run.outcome, run.durationSeconds],
    ),
    [
      ["sha1", 1, "failure", 300],
      ["sha1", 2, "success", 600],
    ],
  );
  assertEquals(
    snapshot.input.ciRuns.filter((run) => run.kind === "job").map((run) => [
      run.attempt,
      run.durationSeconds,
    ]),
    [[1, 240], [2, 480]],
  );
  assert(
    fixture.calls.includes(
      "repos/org/repo/actions/runs?head_sha=sha2&per_page=100&page=1",
    ),
  );
  assert(
    fixture.calls.some((path) =>
      path.startsWith("repos/org/repo/commits/sha2/check-runs?") &&
      path.includes("filter=all")
    ),
  );
  // The merge commit's runs are read for post-merge regressions only, so they
  // do not enter the CI history that feeds the cost totals.
  assert(
    fixture.calls.includes(
      "repos/org/repo/actions/runs?head_sha=merge1&per_page=100&page=1",
    ),
  );
  assertEquals(
    snapshot.input.ciRuns.filter((run) => run.headSha === "merge1"),
    [],
  );
  // The sha1 failure completed before the merge: a blocker, not a regression.
  assertEquals(snapshot.input.blockers, [{
    repo: REPO,
    prNumber: 1,
    blocker: "ci-failure",
    startedAt: "2026-10-20T00:05:00Z",
    endedAt: "2026-10-20T00:20:00Z",
  }]);
  // The merge commit's failure completed after the merge: a post-merge
  // regression, resolved by its later successful attempt.
  assertEquals(snapshot.input.regressions, [{
    repo: REPO,
    prNumber: 1,
    detectedAt: "2026-10-20T00:50:00Z",
    resolved: true,
    source: "post_merge_ci",
  }]);
});

/**
 * Fixture parts for PR 1 (merged at 02:00 onto the merge commit `merge1`) with
 * workflow run 77 (workflow 9) on that commit. Each attempt gives `conclusion`,
 * `started` and `ended`, and the attempts are numbered from 1.
 */
function mergeCommitRun(attempts: Json[]): Partial<Fixture> {
  return {
    pulls: { [REPO]: [pull(1)] },
    workflowRuns: {
      merge1: {
        total_count: 1,
        workflow_runs: [{
          id: 77,
          run_attempt: attempts.length,
          workflow_id: 9,
        }],
      },
    },
    workflowAttempts: Object.fromEntries(
      attempts.map((attempt, index) => [
        `77:${index + 1}`,
        {
          id: 77,
          workflow_id: 9,
          run_attempt: index + 1,
          status: "completed",
          conclusion: attempt.conclusion,
          run_started_at: attempt.started,
          updated_at: attempt.ended,
        },
      ]),
    ),
  };
}

const MERGE_FAILED = {
  conclusion: "failure",
  started: "2026-10-20T02:10:00Z",
  ended: "2026-10-20T02:20:00Z",
};

Deno.test("collect - a failed run on the merge commit is a post-merge regression, resolved by a later successful attempt", async () => {
  const cases: Array<{ name: string; attempts: Json[]; resolved: boolean }> = [
    { name: "unrecovered", attempts: [MERGE_FAILED], resolved: false },
    {
      name: "recovered by a later attempt",
      attempts: [MERGE_FAILED, {
        conclusion: "success",
        started: "2026-10-20T02:25:00Z",
        ended: "2026-10-20T02:30:00Z",
      }],
      resolved: true,
    },
  ];
  for (const c of cases) {
    const snapshot = await collectPrCompletionSnapshot(
      options(fakeGh(emptyFixture(mergeCommitRun(c.attempts)))),
    );
    assertEquals(snapshot.input.regressions, [{
      repo: REPO,
      prNumber: 1,
      detectedAt: "2026-10-20T02:20:00Z",
      resolved: c.resolved,
      source: "post_merge_ci",
    }], c.name);
  }
});

Deno.test("collect - a cancelled run on the merge commit is not a post-merge regression", async () => {
  const snapshot = await collectPrCompletionSnapshot(
    options(fakeGh(emptyFixture(mergeCommitRun([{
      conclusion: "cancelled",
      started: "2026-10-20T02:10:00Z",
      ended: "2026-10-20T02:20:00Z",
    }])))),
  );
  assertEquals(snapshot.input.regressions, []);
});

Deno.test("collect - a failure on the PR head after the merge is not a post-merge regression", async () => {
  // The head's run fails after the merge, but the merge commit has no runs.
  const fixture = emptyFixture({
    pulls: { [REPO]: [pull(1)] },
    workflowRuns: {
      sha1: {
        total_count: 1,
        workflow_runs: [{ id: 55, run_attempt: 1, workflow_id: 9 }],
      },
    },
    workflowAttempts: {
      "55:1": {
        id: 55,
        workflow_id: 9,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        run_started_at: "2026-10-20T02:10:00Z",
        updated_at: "2026-10-20T02:20:00Z",
      },
    },
  });
  const snapshot = await collectPrCompletionSnapshot(options(fakeGh(fixture)));
  assertEquals(snapshot.input.regressions, []);
  // The merge commit was read, and found no runs: the head's failure is not it.
  assert(
    fixture.calls.includes(
      "repos/org/repo/actions/runs?head_sha=merge1&per_page=100&page=1",
    ),
  );
});

Deno.test("collect - a merged PR without a merge commit SHA is noted, and its post-merge CI is not guessed", async () => {
  for (const variant of ["null", "absent"]) {
    const row = pull(1);
    if (variant === "null") row.merge_commit_sha = null;
    else delete row.merge_commit_sha;
    const fixture = emptyFixture({
      pulls: { [REPO]: [row] },
      workflowRuns: {
        sha1: {
          total_count: 1,
          workflow_runs: [{ id: 55, run_attempt: 1, workflow_id: 9 }],
        },
      },
      workflowAttempts: {
        "55:1": {
          id: 55,
          workflow_id: 9,
          run_attempt: 1,
          status: "completed",
          conclusion: "success",
          run_started_at: "2026-10-20T00:00:00Z",
          updated_at: "2026-10-20T00:05:00Z",
        },
      },
    });
    const snapshot = await collectPrCompletionSnapshot(
      options(fakeGh(fixture)),
    );
    assertStringIncludes(
      snapshot.coverageNotes.join("\n"),
      `${
        pk(1)
      }: merge commit SHA is null or absent; post-merge CI is not observed`,
      variant,
    );
    assertEquals(snapshot.input.regressions, [], variant);
    assertEquals(
      fixture.calls.some((path) => path.includes("head_sha=merge")),
      false,
      variant,
    );
  }
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

Deno.test("collect - a CI failure fixed by a later run of the same workflow on a new head closes when that run completes", async () => {
  const fixture = emptyFixture({
    pulls: {
      [REPO]: [pull(1, {
        state: "open",
        merged_at: null,
        closed_at: null,
        head: { ref: "issue-1", sha: "sha2" },
      })],
    },
    commits: {
      [pk(1)]: [
        commit("sha1", "2026-10-20T00:01:00Z"),
        commit("sha2", "2026-10-20T00:10:00Z"),
      ],
    },
    workflowRuns: {
      sha1: {
        total_count: 1,
        workflow_runs: [{ id: 60, run_attempt: 1, workflow_id: 9 }],
      },
      sha2: {
        total_count: 1,
        workflow_runs: [{ id: 61, run_attempt: 1, workflow_id: 9 }],
      },
    },
    workflowAttempts: {
      "60:1": {
        id: 60,
        workflow_id: 9,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        run_started_at: "2026-10-20T00:00:00Z",
        updated_at: "2026-10-20T00:05:00Z",
      },
      "61:1": {
        id: 61,
        workflow_id: 9,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-10-20T00:12:00Z",
        updated_at: "2026-10-20T00:20:00Z",
      },
    },
  });
  const snapshot = await collectPrCompletionSnapshot(options(fakeGh(fixture)));
  assertEquals(snapshot.input.blockers, [{
    repo: REPO,
    prNumber: 1,
    blocker: "ci-failure",
    startedAt: "2026-10-20T00:05:00Z",
    endedAt: "2026-10-20T00:20:00Z",
  }]);
});

Deno.test("collect - a CI blocker on a merged PR never runs past the merge, recovered or not, and a failure after it is no blocker", async () => {
  // PR 1 merges at 00:10. Workflow 9 fails on sha1 before the merge and is
  // recovered on sha2 after it. Workflow 10 fails before the merge and is never
  // recovered. Workflow 11 fails after the merge, so it is not a blocker.
  const fixture = emptyFixture({
    pulls: {
      [REPO]: [pull(1, {
        created_at: "2026-10-20T00:00:00Z",
        merged_at: "2026-10-20T00:10:00Z",
        closed_at: "2026-10-20T00:10:00Z",
      })],
    },
    commits: {
      [pk(1)]: [
        commit("sha1", "2026-10-20T00:01:00Z"),
        commit("sha2", "2026-10-20T00:06:00Z"),
      ],
    },
    workflowRuns: {
      sha1: {
        total_count: 3,
        workflow_runs: [
          { id: 60, run_attempt: 1, workflow_id: 9 },
          { id: 62, run_attempt: 1, workflow_id: 10 },
          { id: 64, run_attempt: 1, workflow_id: 11 },
        ],
      },
      sha2: {
        total_count: 1,
        workflow_runs: [{ id: 61, run_attempt: 1, workflow_id: 9 }],
      },
    },
    workflowAttempts: {
      "60:1": {
        id: 60,
        workflow_id: 9,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        run_started_at: "2026-10-20T00:00:00Z",
        updated_at: "2026-10-20T00:05:00Z",
      },
      "62:1": {
        id: 62,
        workflow_id: 10,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        run_started_at: "2026-10-20T00:02:00Z",
        updated_at: "2026-10-20T00:07:00Z",
      },
      "64:1": {
        id: 64,
        workflow_id: 11,
        run_attempt: 1,
        status: "completed",
        conclusion: "failure",
        run_started_at: "2026-10-20T00:25:00Z",
        updated_at: "2026-10-20T00:30:00Z",
      },
      "61:1": {
        id: 61,
        workflow_id: 9,
        run_attempt: 1,
        status: "completed",
        conclusion: "success",
        run_started_at: "2026-10-20T00:25:00Z",
        updated_at: "2026-10-20T00:30:00Z",
      },
    },
  });
  const snapshot = await collectPrCompletionSnapshot(options(fakeGh(fixture)));
  assertEquals(snapshot.input.blockers, [
    {
      repo: REPO,
      prNumber: 1,
      blocker: "ci-failure",
      startedAt: "2026-10-20T00:05:00Z",
      endedAt: "2026-10-20T00:10:00Z",
    },
    {
      repo: REPO,
      prNumber: 1,
      blocker: "ci-failure",
      startedAt: "2026-10-20T00:07:00Z",
      endedAt: "2026-10-20T00:10:00Z",
    },
  ]);
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
    source: "revert",
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
        hostId: "host-a",
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
          hostId: "host-a",
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
          inventory: [
            { hostId: "host-a", component: "worker" },
            { hostId: "host-a", component: "reviewer" },
            { hostId: "host-a", component: "babysitter" },
          ],
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
    for (
      const [number, event] of [
        [2, "discovered"],
        [2, "eligible"],
        [2, "processed"],
        [3, "discovered"],
        [3, "eligible"],
      ] as const
    ) {
      await appendPrDiscoveryEvent(`${dir}/pr-discovery-events.jsonl`, {
        event,
        hostId: "host-a",
        repo: REPO,
        prNumber: number,
        headSha: `sha${number}`,
        recordedAt: "2026-10-26T00:00:00Z",
      });
    }
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
        babysitterStateDirs: [dir],
        expected: {
          components: ["worker", "babysitter"],
          inventory: [{ hostId: "host-a", component: "babysitter" }],
          revision: "rev1",
          policyFingerprint: FP,
          maxHeartbeatAgeHours: 24,
        },
        rolloutVerifiedAt: "2026-10-25T00:00:00Z",
      },
    ));
    const stranded = snapshot.input.rollout!.strandedPrs
      .map((pr) => ({
        prNumber: pr.prNumber,
        discovered: pr.discovered,
        eligibilityConfirmed: pr.eligibilityConfirmed,
        processed: pr.processed,
      }))
      .sort((a, b) => a.prNumber - b.prNumber);
    assertEquals(stranded, [
      {
        prNumber: 1,
        discovered: false,
        eligibilityConfirmed: false,
        processed: false,
      },
      {
        prNumber: 2,
        discovered: true,
        eligibilityConfirmed: true,
        processed: true,
      },
      {
        prNumber: 3,
        discovered: true,
        eligibilityConfirmed: true,
        processed: false,
      },
    ]);
    assertEquals(snapshot.input.rollout!.discoveryEvidenceComplete, true);
    assertEquals(snapshot.input.rollout!.verifiedAt, "2026-10-25T00:00:00Z");
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.rollout.eligibleStrandedPrs, 3);
    assertEquals(report.rollout.discoveredPrs, 2);
    assertEquals(report.rollout.eligibleEventPrs, 2);
    assertEquals(report.rollout.rediscoveredPrs, 2);
    assertEquals(report.rollout.processedPrs, 1);
    assertEquals(report.rollout.notRediscoveredPrs, 1);
    assertEquals(report.rollout.unknownDiscoveryPrs, 0);
  });
});

const BABYSITTER_HOSTS_NOTE =
  "PR discovery events do not cover every expected babysitter host; rollout remains unknown";

Deno.test("collect - rollout discovery is incomplete unless every expected babysitter host has discovery events", async () => {
  const cases: Array<{ name: string; hosts: string[]; noted: boolean }> = [
    { name: "a host is missing", hosts: ["host-a"], noted: true },
    {
      name: "every host is covered",
      hosts: ["host-a", "host-b"],
      noted: false,
    },
  ];
  for (const c of cases) {
    await withDir(async (dir) => {
      for (const hostId of c.hosts) {
        await appendPrDiscoveryEvent(`${dir}/pr-discovery-events.jsonl`, {
          event: "discovered",
          hostId,
          repo: REPO,
          prNumber: 2,
          headSha: "sha2",
          recordedAt: "2026-10-26T00:00:00Z",
        });
      }
      const snapshot = await collectPrCompletionSnapshot(options(
        fakeGh(emptyFixture()),
        {
          babysitterStateDirs: [dir],
          expected: {
            components: ["worker", "babysitter"],
            inventory: [
              { hostId: "host-a", component: "babysitter" },
              { hostId: "host-b", component: "babysitter" },
            ],
            revision: "rev1",
            policyFingerprint: FP,
            maxHeartbeatAgeHours: 24,
          },
          rolloutVerifiedAt: "2026-10-25T00:00:00Z",
        },
      ));
      assertEquals(
        snapshot.coverageNotes.includes(BABYSITTER_HOSTS_NOTE),
        c.noted,
        c.name,
      );
      assertEquals(
        snapshot.input.rollout!.discoveryEvidenceComplete,
        !c.noted,
        c.name,
      );
    });
  }
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

/** Collect a one-repository cohort of `pulls` with no audit journal. */
async function collectPulls(
  pulls: Json[],
  defaultBranch = "main",
): Promise<CollectedSnapshot> {
  return await collectPrCompletionSnapshot(
    options(fakeGh(emptyFixture({ pulls: { [REPO]: pulls }, defaultBranch }))),
  );
}

const MILESTONE = "milestone/4658";

Deno.test("collect - a milestone PR with one default-branch rollup is an intermediate rollup, not a delivery", async () => {
  const snapshot = await collectPulls([
    pull(10, {
      created_at: "2026-10-19T00:00:00Z",
      merged_at: "2026-10-19T02:00:00Z",
      base: { ref: MILESTONE },
      head: { ref: "issue-10", sha: "sha10" },
    }),
    pull(11, {
      created_at: "2026-10-20T00:00:00Z",
      merged_at: "2026-10-20T02:00:00Z",
      base: { ref: "main" },
      head: { ref: MILESTONE, sha: "sha11" },
    }),
    // An unrelated default-branch change must not spoil the single root.
    pull(12, {
      created_at: "2026-10-21T00:00:00Z",
      merged_at: "2026-10-21T02:00:00Z",
      base: { ref: "main" },
      head: { ref: "issue-12", sha: "sha12" },
    }),
  ]);
  assertEquals(
    snapshot.input.prs.find((pr) => pr.number === 10)?.rollupRoot,
    "org/repo#11",
  );
  const report = buildPrCompletionReport(snapshot.input);
  assertEquals(report.delivery.milestonePrs, 1);
  assertEquals(report.delivery.intermediateRollupPrs, 1);
  // The rollup (11) and the unrelated change (12) are deliveries; the
  // milestone PR (10) is not.
  assertEquals(report.delivery.defaultBranchChanges, 2);
});

Deno.test("collect - a milestone PR with no default-branch rollup in the cohort keeps no root", async () => {
  const snapshot = await collectPulls([
    pull(10, {
      created_at: "2026-10-19T00:00:00Z",
      merged_at: "2026-10-19T02:00:00Z",
      base: { ref: MILESTONE },
      head: { ref: "issue-10", sha: "sha10" },
    }),
  ]);
  assertEquals(snapshot.input.prs[0]?.rollupRoot, undefined);
  const report = buildPrCompletionReport(snapshot.input);
  assertEquals(report.delivery.intermediateRollupPrs, 0);
  assertEquals(report.delivery.defaultBranchChanges, 0);
});

Deno.test("collect - two default-branch rollups of one milestone leave its root unset", async () => {
  const snapshot = await collectPulls([
    pull(10, {
      created_at: "2026-10-19T00:00:00Z",
      merged_at: "2026-10-19T02:00:00Z",
      base: { ref: MILESTONE },
      head: { ref: "issue-10", sha: "sha10" },
    }),
    pull(11, {
      created_at: "2026-10-20T00:00:00Z",
      merged_at: "2026-10-20T02:00:00Z",
      base: { ref: "main" },
      head: { ref: MILESTONE, sha: "sha11" },
    }),
    pull(12, {
      created_at: "2026-10-21T00:00:00Z",
      merged_at: "2026-10-21T02:00:00Z",
      base: { ref: "main" },
      head: { ref: MILESTONE, sha: "sha12" },
    }),
  ]);
  assertEquals(
    snapshot.input.prs.find((pr) => pr.number === 10)?.rollupRoot,
    undefined,
  );
  const report = buildPrCompletionReport(snapshot.input);
  assertEquals(report.delivery.intermediateRollupPrs, 0);
  assertEquals(report.delivery.defaultBranchChanges, 2);
});

Deno.test("collect - a milestone PR never roots itself", async () => {
  // The milestone branch is also the default branch here, so the PR would
  // match every condition for itself unless the derivation excludes it.
  const snapshot = await collectPulls([
    pull(10, {
      created_at: "2026-10-19T00:00:00Z",
      merged_at: "2026-10-19T02:00:00Z",
      base: { ref: MILESTONE },
      head: { ref: MILESTONE, sha: "sha10" },
    }),
  ], MILESTONE);
  assertEquals(snapshot.input.prs[0]?.rollupRoot, undefined);
  const report = buildPrCompletionReport(snapshot.input);
  assertEquals(report.delivery.intermediateRollupPrs, 0);
  assertEquals(report.delivery.defaultBranchChanges, 0);
});

Deno.test("collect - each revert pattern reads only its bounded slice and stays exact on hostile text", async () => {
  const snapshot = await collectPulls([
    pull(5, {
      created_at: "2026-10-20T00:00:00Z",
      merged_at: "2026-10-20T02:00:00Z",
    }),
    // Quoted title text of 290 characters, then (#5) inside the title bound.
    pull(6, {
      title: `Revert "${"b".repeat(290)}" ${" ".repeat(600)}(#5)`,
      created_at: "2026-10-22T00:00:00Z",
      merged_at: "2026-10-22T01:00:00Z",
    }),
    pull(7, {
      // Quoted title text over 300 characters: REVERT_TITLE must not match.
      title: `Revert "${"c".repeat(400)}" (#8)`,
      created_at: "2026-10-23T00:00:00Z",
      merged_at: "2026-10-23T01:00:00Z",
    }),
    pull(8, {
      created_at: "2026-10-20T00:00:00Z",
      merged_at: "2026-10-20T02:00:00Z",
    }),
    pull(9, {
      // A long run of "(#" with no digits: QUOTED_PR_REFERENCE finds nothing.
      title: `Revert "Change 9" ${"(#".repeat(2_000)}`,
      created_at: "2026-10-24T00:00:00Z",
      merged_at: "2026-10-24T01:00:00Z",
    }),
    pull(10, {
      // Reverts #8 starts inside the 20,000-character body bound.
      body: `${" ".repeat(19_000)}Reverts #8`,
      created_at: "2026-10-25T00:00:00Z",
      merged_at: "2026-10-25T01:00:00Z",
    }),
    pull(12, {
      created_at: "2026-10-20T00:00:00Z",
      merged_at: "2026-10-20T02:00:00Z",
    }),
    pull(13, {
      // Reverts #12 lies beyond the body bound: it is not seen.
      body: `${"a".repeat(25_000)} Reverts #12`,
      created_at: "2026-10-26T00:00:00Z",
      merged_at: "2026-10-26T01:00:00Z",
    }),
    pull(14, {
      // A long run of spaces, then a rejected character: no reference.
      body: `Reverts ${" ".repeat(30_000)}#${"9".repeat(3_000)}`,
      created_at: "2026-10-27T00:00:00Z",
      merged_at: "2026-10-27T01:00:00Z",
    }),
  ]);
  assertEquals(
    [...snapshot.input.regressions].sort((a, b) => a.prNumber - b.prNumber),
    [
      {
        repo: REPO,
        prNumber: 5,
        detectedAt: "2026-10-22T00:00:00Z",
        resolved: true,
        source: "revert",
      },
      {
        repo: REPO,
        prNumber: 8,
        detectedAt: "2026-10-25T00:00:00Z",
        resolved: true,
        source: "revert",
      },
    ],
  );
});

Deno.test("collect - the rollout check strands only PRs open at verification and at least a day old", async () => {
  await withDir(async (dir) => {
    const verified = "2026-10-25T00:00:00Z";
    await journal(dir, [{
      verb: "pr-review",
      actionKind: "review",
      actionId: "after-merged-31",
      repo: REPO,
      prNumber: 31,
      component: "reviewer",
      timestamp: "2026-10-26T01:00:00Z",
    }]);
    const open = { state: "open", merged_at: null, closed_at: null };
    const snapshot = await collectPrCompletionSnapshot(options(
      fakeGh(emptyFixture({
        pulls: {
          [REPO]: [
            // Open at verification and five days old: stranded.
            pull(30, { ...open, created_at: "2026-10-20T00:00:00Z" }),
            // Merged after verification: still stranded, with no discovery or
            // processing evidence (a later audit action proves neither).
            pull(31, {
              created_at: "2026-10-20T00:00:00Z",
              merged_at: "2026-10-26T00:00:00Z",
              closed_at: "2026-10-26T00:00:00Z",
            }),
            // Merged before verification: excluded.
            pull(32, {
              created_at: "2026-10-20T00:00:00Z",
              merged_at: "2026-10-24T00:00:00Z",
              closed_at: "2026-10-24T00:00:00Z",
            }),
            // Open but twelve hours old at verification: excluded.
            pull(33, { ...open, created_at: "2026-10-24T12:00:00Z" }),
            // Closed exactly at verification: not open at it, excluded.
            pull(34, {
              state: "closed",
              merged_at: null,
              created_at: "2026-10-20T00:00:00Z",
              closed_at: verified,
            }),
            // Owner-gated: excluded.
            pull(35, {
              ...open,
              created_at: "2026-10-20T00:00:00Z",
              labels: [{ name: "needs-human" }],
            }),
          ],
        },
      })),
      { auditDirs: [dir], rolloutVerifiedAt: verified },
    ));
    const stranded = snapshot.input.rollout!.strandedPrs
      .map((pr) => ({
        prNumber: pr.prNumber,
        discovered: pr.discovered,
        eligibilityConfirmed: pr.eligibilityConfirmed,
        processed: pr.processed,
      }))
      .sort((a, b) => a.prNumber - b.prNumber);
    assertEquals(stranded, [
      {
        prNumber: 30,
        discovered: false,
        eligibilityConfirmed: false,
        processed: false,
      },
      {
        prNumber: 31,
        discovered: false,
        eligibilityConfirmed: false,
        processed: false,
      },
    ]);
    assertEquals(snapshot.input.rollout!.discoveryEvidenceComplete, false);
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.rollout.eligibleStrandedPrs, 2);
    assertEquals(report.rollout.rediscoveredPrs, 0);
    assertEquals(report.rollout.processedPrs, 0);
    assertEquals(report.rollout.notRediscoveredPrs, 0);
    assertEquals(report.rollout.unknownDiscoveryPrs, 2);
  });
});

Deno.test("collect - pre-change review-run records and journal entries are ignored with a note", async () => {
  await withDir(async (dir) => {
    const rounds = `${dir}/rounds`;
    await Deno.mkdir(`${rounds}/20261020-100000`, { recursive: true });
    // Written before the deployment field existed.
    await Deno.writeTextFile(
      `${rounds}/20261020-100000/review-run.json`,
      JSON.stringify({ round: "20261020-100000", attempts: [] }),
    );
    const auditDir = `${dir}/audit`;
    await Deno.mkdir(auditDir);
    await journal(auditDir, [
      // Pre-change journal entry: no action ID and no action kind.
      {
        verb: "pr-review",
        repo: REPO,
        prNumber: 1,
        component: "reviewer",
        timestamp: "2026-10-20T01:00:00Z",
      },
      // Carries an action ID but no action kind: not a PR action.
      {
        verb: "pr-merge",
        actionId: "legacy-1",
        repo: REPO,
        prNumber: 1,
        timestamp: "2026-10-20T02:00:00Z",
      },
    ]);
    const snapshot = await collectPrCompletionSnapshot(options(
      fakeGh(emptyFixture({ pulls: { [REPO]: [pull(1)] } })),
      { auditDirs: [auditDir], reviewRunDirs: [rounds] },
    ));
    assertEquals(snapshot.input.deployments, []);
    assertStringIncludes(
      snapshot.coverageNotes.join("\n"),
      "1 record(s) have no deployment field",
    );
    assertEquals(
      snapshot.input.actions.filter((action) => action.actionId === "legacy-1")
        .length,
      0,
    );
    // The chain verified, so the completeness flag is unchanged by the legacy entries.
    assertEquals(snapshot.input.prs[0]!.actionsComplete, true);
  });
});

/** The approval GitHub records for PR 1 at 01:00, with its review id. */
const REVIEW_AT = "2026-10-20T01:00:00Z";

/** A GitHub review as the reviews endpoint returns it. */
function review(id: number, submittedAt: string): Json {
  return {
    id,
    state: "APPROVED",
    submitted_at: submittedAt,
    commit_id: "sha1",
    user: { login: "review-bot[bot]" },
  };
}

/** One review-log line, as the review-fleet-prs skill appends it. */
function logLine(number: number, at: string, headSha = "sha1"): string {
  return JSON.stringify({
    at,
    repo: REPO,
    number,
    title: `Change ${number}`,
    url: `https://github.com/${REPO}/pull/${number}`,
    headSha,
    outcome: "approved",
    summary: "Looks right.",
    findings: [],
    testChangeNotes: [],
    removedTests: [],
  });
}

/**
 * Write a review log. Logs live in their own directory, apart from the audit
 * directory, which reads every `.jsonl` file directly beneath it as a journal.
 */
async function writeLines(path: string, lines: string[]): Promise<string> {
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, lines.join("\n") + "\n");
  return path;
}

/**
 * PR 1, merged at 02:00, with its implementation and merge journalled and its
 * one GitHub review at 01:00. Only the review-log sources vary between tests.
 */
async function reviewedPr(
  dir: string,
  extra: Partial<CollectOptions> = {},
): Promise<CollectedSnapshot> {
  await journal(dir, [
    {
      verb: "git-push",
      actionKind: "implementation",
      actionId: "a-push-review",
      deliveredCommits: ["sha1"],
      target: "issue-1",
      timestamp: "2026-10-20T00:30:00Z",
    },
    {
      verb: "pr-merge",
      actionKind: "merge",
      actionId: "a-merge-review",
      repo: REPO,
      prNumber: 1,
      timestamp: "2026-10-20T02:00:00Z",
    },
  ]);
  const fixture = emptyFixture({
    pulls: { [REPO]: [pull(1)] },
    reviews: { [pk(1)]: [review(601, REVIEW_AT)] },
    commits: { [pk(1)]: [commit("sha1", "2026-10-20T00:25:00Z")] },
  });
  return await collectPrCompletionSnapshot(
    options(fakeGh(fixture), { auditDirs: [dir], ...extra }),
  );
}

Deno.test("collect - an unchained review log cannot verify a PR's history", async () => {
  await withDir(async (dir) => {
    const log = await writeLines(`${dir}/logs/log.jsonl`, [
      // Thirty seconds after GitHub's review, recorded at an older head.
      logLine(1, "2026-10-20T01:00:30Z", "older-head"),
    ]);
    const snapshot = await reviewedPr(dir, { reviewLogs: [log] });
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 0);
    assertEquals(report.completion.unknownMerged, 1);
    assertEquals(
      snapshot.input.actions.some((action) =>
        action.actionId === "gh:org/repo#1:review:601"
      ),
      true,
      "the GitHub review at a different head must stay an unknown action",
    );
    const logged = snapshot.input.actions.find((action) =>
      action.actionId === "review-log:org/repo#1:2026-10-20T01:00:30Z"
    );
    assertEquals(logged?.kind, "review");
    assertEquals(logged?.actor, "unknown");
    assertEquals(logged?.verified, false);
    assertEquals(logged?.outcome, "confirmed");
    assertEquals(logged?.headSha, "older-head");
    assertEquals(
      snapshot.coverageNotes.some((note) =>
        note.includes("had no review-log source")
      ),
      false,
    );
  });
});

Deno.test("collect - a review-log record 15 minutes from a GitHub review does not match, so the PR stays unknown", async () => {
  await withDir(async (dir) => {
    const log = await writeLines(`${dir}/logs/log.jsonl`, [
      logLine(1, "2026-10-20T01:15:00Z"),
    ]);
    const snapshot = await reviewedPr(dir, { reviewLogs: [log] });
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 0);
    assertEquals(report.completion.unknownMerged, 1);
    const event = snapshot.input.actions.find((action) =>
      action.actionId === "gh:org/repo#1:review:601"
    );
    assertEquals(event?.actor, "unknown");
    assertEquals(event?.verified, false);
  });
});

Deno.test("collect - with no review log the GitHub review stays unknown and a coverage note says why", async () => {
  await withDir(async (dir) => {
    const snapshot = await reviewedPr(dir);
    assertEquals(
      buildPrCompletionReport(snapshot.input).completion.unattendedMerged,
      0,
    );
    const note = snapshot.coverageNotes.find((item) =>
      item.includes("had no review-log source")
    );
    assertStringIncludes(
      note ?? "",
      "1 review event on 1 PR had no review-log source",
    );
  });
});

Deno.test("collect - a malformed review-log line is noted and skipped, while good lines count and out-of-cohort records are ignored", async () => {
  await withDir(async (dir) => {
    const log = await writeLines(`${dir}/logs/log.jsonl`, [
      '{"at": "2026-10-20T01:00:3', // a torn line from an interrupted write
      logLine(1, "2026-10-20T01:00:30Z"),
      logLine(99, "2026-10-20T01:00:30Z"), // PR 99 is not in the cohort
    ]);
    const snapshot = await reviewedPr(dir, { reviewLogs: [log] });
    const note = snapshot.coverageNotes.find((item) =>
      item.includes("malformed")
    );
    assertStringIncludes(
      note ?? "",
      `review log ${log}: 1 malformed line(s) skipped`,
    );
    assertEquals(
      buildPrCompletionReport(snapshot.input).completion.unknownMerged,
      1,
    );
    assertEquals(
      snapshot.input.actions.filter((action) => action.prNumber === 99).length,
      0,
    );
  });
});

Deno.test("collect - the same review-log record in two logs is one action, counted once", async () => {
  await withDir(async (dir) => {
    const line = logLine(1, "2026-10-20T01:00:30Z");
    const logs = [
      await writeLines(`${dir}/logs/host-a.jsonl`, [line]),
      await writeLines(`${dir}/logs/host-b.jsonl`, [line]),
    ];
    const snapshot = await reviewedPr(dir, { reviewLogs: logs });
    assertEquals(
      snapshot.input.actions.filter((action) =>
        action.actionId.startsWith("review-log:")
      ).length,
      1,
    );
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 0);
    assertEquals(report.completion.unknownMerged, 1);
    assertEquals(report.coverage.unknownPrHistory, 0);
    assertEquals(report.delivery.reviewRounds, 1);
  });
});

Deno.test("collect - a review log that is missing is noted, never silent, and its reviews stay unknown", async () => {
  await withDir(async (dir) => {
    const path = `${dir}/logs/absent.jsonl`;
    const snapshot = await reviewedPr(dir, { reviewLogs: [path] });
    assert(
      snapshot.coverageNotes.includes(`review log ${path} is missing; skipped`),
    );
    assertEquals(
      buildPrCompletionReport(snapshot.input).completion.unattendedMerged,
      0,
    );
  });
});

Deno.test("collect - an omitted key GitHub always sends is malformed, never an empty state", async () => {
  // Each key is removed from an otherwise valid pull; the refusal names it.
  for (const key of ["state", "merged_at", "closed_at", "labels", "body"]) {
    const row = pull(50);
    delete row[key];
    const fixture = emptyFixture({ pulls: { [REPO]: [row] } });
    await assertRejects(
      () => collectPrCompletionSnapshot(options(fakeGh(fixture))),
      Error,
      `${pk(50)} is missing ${key}`,
    );
  }
  // A review without its state or its submitted_at key is refused the same way.
  for (const key of ["state", "submitted_at"]) {
    const review: Json = {
      id: 601,
      state: "APPROVED",
      submitted_at: "2026-10-20T01:00:00Z",
    };
    delete review[key];
    const fixture = emptyFixture({
      pulls: { [REPO]: [pull(50)] },
      reviews: { [pk(50)]: [review] },
    });
    await assertRejects(
      () => collectPrCompletionSnapshot(options(fakeGh(fixture))),
      Error,
      `${pk(50)} review is missing ${key}`,
    );
  }
});

Deno.test("collect - explicit null and empty values are accepted as the empty state", async () => {
  const open = pull(51, {
    state: "open",
    merged_at: null,
    closed_at: null,
    labels: [],
    body: null,
  });
  const pending = {
    id: 602,
    state: "PENDING",
    submitted_at: null,
    user: { login: "alice" },
  };
  const fixture = emptyFixture({
    pulls: { [REPO]: [open] },
    reviews: { [pk(51)]: [pending] },
  });
  const snapshot = await collectPrCompletionSnapshot(options(fakeGh(fixture)));
  const [record] = snapshot.input.prs;
  assertEquals(record?.state, "open");
  assertEquals(record?.mergedAt, null);
  assertEquals(record?.closedAt, null);
  assertEquals(record?.ownerGated, false);
  // A pending review has no submitted_at, so it is not an action.
  assertEquals(
    snapshot.input.actions.filter((a) => a.kind === "review").length,
    0,
  );
});

Deno.test("collect - a page-truncated event list and a partial check-run list are coverage notes", async () => {
  // 1,000 reviews fill ten full pages, which is the bound.
  const reviews = Array.from({ length: 1_000 }, (_, i) => ({
    id: i + 1,
    state: "COMMENTED",
    submitted_at: "2026-10-20T01:00:00Z",
  }));
  const fixture = emptyFixture({
    pulls: { [REPO]: [pull(50)] },
    reviews: { [pk(50)]: reviews },
    checks: {
      sha50: {
        total_count: 3,
        check_runs: [{
          id: 9,
          status: "completed",
          started_at: "2026-10-20T00:10:00Z",
          completed_at: "2026-10-20T00:20:00Z",
        }],
      },
    },
  });
  const snapshot = await collectPrCompletionSnapshot(options(fakeGh(fixture)));
  const notes = snapshot.coverageNotes.join("\n");
  assertStringIncludes(notes, `${pk(50)}: reviews truncated after 10 pages`);
  assertStringIncludes(notes, `${pk(50)}: 1 of 3 check runs listed`);
});

Deno.test("collect - a deployment row with a bad field is refused by name and not counted", async () => {
  await withDir(async (dir) => {
    const observedAt = "2026-10-30T00:00:00Z";
    const rows: Array<[string, Json, string]> = [
      [
        "bad-component",
        {
          component: "Worker!",
          codeRevision: "rev1",
          policyFingerprint: FP,
          observedAt,
        },
        "component is not a component identifier",
      ],
      [
        "no-revision",
        { component: "worker", policyFingerprint: FP, observedAt },
        "revision is missing",
      ],
      [
        "bad-fingerprint",
        {
          component: "worker",
          codeRevision: "rev1",
          policyFingerprint: "abc",
          observedAt,
        },
        "policy fingerprint is not a SHA-256 fingerprint",
      ],
      [
        "no-observed",
        { component: "worker", codeRevision: "rev1", policyFingerprint: FP },
        "observedAt is missing",
      ],
    ];
    for (const [round, deployment] of rows) {
      await Deno.mkdir(`${dir}/${round}`);
      await Deno.writeTextFile(
        `${dir}/${round}/review-run.json`,
        JSON.stringify({ deployment }),
      );
    }
    const snapshot = await collectPrCompletionSnapshot(options(
      fakeGh(emptyFixture()),
      { reviewRunDirs: [dir] },
    ));
    const notes = snapshot.coverageNotes.join("\n");
    for (const [round, , message] of rows) {
      assertStringIncludes(
        notes,
        `${dir}/${round}/review-run.json: ${message}; skipped`,
      );
    }
    assertEquals(snapshot.input.deployments.length, 0);
  });
});

Deno.test("collect - an unreadable review-run directory, a malformed ledger and an old heartbeat are noted", async () => {
  await withDir(async (dir) => {
    // A round whose deployment is valid but older than the 24-hour window.
    await Deno.mkdir(`${dir}/old-round`);
    await Deno.writeTextFile(
      `${dir}/old-round/review-run.json`,
      JSON.stringify({
        deployment: {
          component: "worker",
          codeRevision: "rev1",
          policyFingerprint: FP,
          observedAt: "2026-10-01T00:00:00Z",
        },
      }),
    );
    const ledger = `${dir}/bad-ledger.jsonl`;
    await Deno.writeTextFile(ledger, "{not json\n");
    const snapshot = await collectPrCompletionSnapshot(options(
      fakeGh(emptyFixture()),
      {
        reviewRunDirs: [dir, `${dir}/no-such-dir`],
        lifecycleLedgers: [ledger],
      },
    ));
    const notes = snapshot.coverageNotes.join("\n");
    assertStringIncludes(
      notes,
      `review-run dir ${dir}/no-such-dir is unreadable`,
    );
    assertStringIncludes(notes, `lifecycle ledger ${ledger} is malformed (`);
    assertStringIncludes(
      notes,
      "1 review-run or lifecycle deployment record(s) older than the 24h heartbeat window were not counted",
    );
    assertEquals(snapshot.input.deployments.length, 0);
  });
});

Deno.test("collect - human-looking logins on a matched PR never downgrade it from unattended", async () => {
  await withDir(async (dir) => {
    await journal(dir, [
      {
        verb: "git-push",
        actionKind: "implementation",
        actionId: "a-push-31",
        deliveredCommits: ["sha31"],
        target: "issue-31",
        timestamp: "2026-10-20T00:30:00Z",
      },
      {
        verb: "pr-merge",
        actionKind: "merge",
        actionId: "a-merge-31",
        repo: REPO,
        prNumber: 31,
        timestamp: "2026-10-20T02:00:00Z",
      },
    ]);
    const fixture = emptyFixture({
      pulls: {
        [REPO]: [pull(31, {
          user: { login: "alice", type: "User" },
          merged_by: { login: "alice", type: "User" },
        })],
      },
      commits: {
        [pk(31)]: [{
          ...commit("sha31", "2026-10-20T00:25:00Z"),
          author: { login: "alice", type: "User" },
          committer: { login: "alice", type: "User" },
        }],
      },
    });
    const snapshot = await collectPrCompletionSnapshot(
      options(fakeGh(fixture), { auditDirs: [dir] }),
    );
    const report = buildPrCompletionReport(snapshot.input);
    assertEquals(report.completion.unattendedMerged, 1);
    assertEquals(report.completion.humanAssistedMerged, 0);
    assertEquals(report.completion.unknownMerged, 0);
    assertEquals(
      snapshot.input.actions.filter((action) => action.actor !== "fleet")
        .length,
      0,
    );
  });
});

Deno.test("collect - open PRs from before the cohort are counted, whether on the first or a later page", async () => {
  const stale = (number: number, state = "open") =>
    pull(number, {
      state,
      created_at: "2026-09-01T00:00:00Z",
      merged_at: null,
    });
  // Two pre-cohort open PRs, one pre-cohort closed PR, and a cohort PR that
  // is itself open: only the first two are "before the cohort".
  const fixture = emptyFixture({
    pulls: {
      [REPO]: [
        stale(41),
        stale(42, "closed"),
        stale(43),
        pull(40, { state: "open", merged_at: null }),
      ],
    },
  });
  const snapshot = await collectPrCompletionSnapshot(
    options(fakeGh(fixture)),
  );
  assertEquals(snapshot.input.openPrsBeforeCohort, 2);
  assertEquals(snapshot.input.prs.length, 1);
  const report = buildPrCompletionReport(snapshot.input);
  assertEquals(report.coverage.openPrsBeforeCohort, 2);
  assertEquals(report.cohort.prCount, 1);

  // Oldest first, the scan ends at the first PR inside the cohort.
  const ordered = emptyFixture({
    pulls: {
      [REPO]: [
        stale(44),
        pull(45, { state: "open", merged_at: null }),
        stale(46),
      ],
    },
  });
  const stopped = await collectPrCompletionSnapshot(
    options(fakeGh(ordered)),
  );
  assertEquals(stopped.input.openPrsBeforeCohort, 1);

  // A bound reached on a full page of
  // open PRs marks the repository truncated.
  const many = Array.from(
    { length: 150 },
    (_, i) => stale(1_000 + i),
  );
  const big = emptyFixture({ pulls: { [REPO]: many } });
  const capped = await collectPrCompletionSnapshot(
    options(fakeGh(big), { maxPrsPerRepo: 100 }),
  );
  assertEquals(capped.input.openPrsBeforeCohort, 100);
  assertEquals(capped.truncatedRepos, [REPO]);
});
