/**
 * Regression tests for Issue #1561 — False alarm "Issue Modified After Approval".
 *
 * Scenario: a trusted author adds `work-on`; the worker captures a snapshot;
 * later the issue is legitimately refined (content changes); the trusted
 * author re-adds `work-on` to approve the refined content. The worker
 * previously blocked the issue because the stored snapshot predated the
 * refinement — the fix is to detect that the work-on label was re-added
 * AFTER the snapshot was captured and to treat it as a fresh approval.
 *
 * Tests exercise `verifyWorkOnContentIntegrity` directly so the scenario
 * logic is isolated from the wider finder orchestration.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { verifyWorkOnContentIntegrity } from "../lib/work_on_content_integrity.ts";
import {
  captureContentSnapshot,
  type ContentApprovalDeps,
  loadContentApprovalState,
} from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import { getLabelLastAddInfo } from "../lib/issue_query.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMemoryFs(): {
  deps: ContentApprovalDeps;
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const deps: ContentApprovalDeps = {
    readFile: async (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        throw new Deno.errors.NotFound(`File not found: ${path}`);
      }
      return content;
    },
    writeFile: async (path: string, content: string) => {
      files.set(path, content);
    },
    renameFile: async (oldPath: string, newPath: string) => {
      const content = files.get(oldPath);
      if (content === undefined) throw new Error(`File not found: ${oldPath}`);
      files.set(newPath, content);
      files.delete(oldPath);
    },
    removeFile: async (path: string) => {
      files.delete(path);
    },
  };
  return { deps, files };
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const base = buildDefaultWorkerConfig();
  return {
    ...base,
    repos: ["owner/repo"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    workDir: "/tmp/work-integrity-test",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<FilterableIssue> = {}): FilterableIssue {
  return {
    number: 42,
    title: "Fix the bug",
    url: "https://github.com/owner/repo/issues/42",
    assignees: [],
    labels: ["work-on"],
    createdAt: "2026-04-23T00:00:00Z",
    author: "worker-bot",
    milestone: "",
    ...overrides,
  };
}

interface TimelineEvent {
  event: string;
  label?: { name: string };
  actor?: { login: string };
  created_at?: string;
}

interface GhMockOptions {
  issueTitle: string;
  issueBody: string;
  timeline: TimelineEvent[];
  actions?: string[];
  /** Captures the label names passed to `--add-label` and to REST add-label calls. */
  addedLabels?: string[];
  /** Captures the label names passed to label-create calls. */
  createdLabels?: string[];
  /**
   * Issue #3715: login recorded against the most recent title/body edit.
   * The re-baseline decision now turns on this actor rather than the issue
   * author, so scenarios that change content must name the editor.
   */
  editedBy?: string;
}

function createGhMock(
  opts: GhMockOptions,
): (args: string[]) => Promise<string> {
  const actions = opts.actions ?? [];
  const addedLabels = opts.addedLabels ?? [];
  const createdLabels = opts.createdLabels ?? [];
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");

    // Issue #3715: edit-actor lookup — who actually made the edit.
    // Matched on `userContentEdits` so other GraphQL queries fall through.
    if (args[0] === "api" && command.includes("userContentEdits")) {
      // Issue #3964: the edit must post-date the snapshot (captured at real
      // wall-clock time unless a test overrides capturedAt to an instant
      // before this) to land inside the judged window — a mismatch with zero
      // in-window edits now re-baselines instead.
      const nodes = opts.editedBy
        ? [{
          editedAt: new Date(Date.now() + 3600_000).toISOString(),
          editor: { login: opts.editedBy },
        }]
        : [];
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            issue: {
              userContentEdits: { nodes },
              timelineItems: { nodes: [] },
            },
          },
        },
      }));
    }

    if (command.includes("api") && command.includes("timeline")) {
      return Promise.resolve(JSON.stringify(opts.timeline));
    }
    if (command.includes("issue view") && command.includes("title,body")) {
      return Promise.resolve(
        JSON.stringify({ title: opts.issueTitle, body: opts.issueBody }),
      );
    }
    if (command.includes("--remove-label")) {
      actions.push("remove-label");
      return Promise.resolve("");
    }
    // REST API add-label: gh api -X POST repos/.../issues/N/labels -f labels[]=<name>
    if (
      command.includes("api") && command.includes("POST") &&
      command.includes("/labels") && command.includes("labels[]=")
    ) {
      actions.push("add-label");
      const match = args.find((a) => a.startsWith("labels[]="));
      if (match) addedLabels.push(match.slice("labels[]=".length));
      return Promise.resolve("");
    }
    if (command.includes("--add-label")) {
      actions.push("add-label");
      const idx = args.indexOf("--add-label");
      const next = idx >= 0 ? args[idx + 1] : undefined;
      if (next !== undefined) addedLabels.push(next);
      return Promise.resolve("");
    }
    // REST API create-label: gh api -X POST repos/<owner>/<repo>/labels -f name=<name> ...
    if (
      command.includes("api") && command.includes("POST") &&
      command.includes("/labels") && args.some((a) => a.startsWith("name="))
    ) {
      actions.push("create-label");
      const nameArg = args.find((a) => a.startsWith("name="));
      if (nameArg) createdLabels.push(nameArg.slice("name=".length));
      return Promise.resolve("");
    }
    // CLI fallback: gh label create <name> --repo <repo> ...
    if (
      command.startsWith("label create") || command.includes(" label create ")
    ) {
      actions.push("create-label");
      // The label name follows "create" in the args list.
      const idx = args.indexOf("create");
      const next = idx >= 0 ? args[idx + 1] : undefined;
      if (next !== undefined) createdLabels.push(next);
      return Promise.resolve("");
    }
    if (command.includes("issue comment")) {
      actions.push("post-comment");
      return Promise.resolve("");
    }
    // Issue #2211: escalateToHuman's shim posts comments via REST API
    // (POST /repos/.../issues/N/comments -f body=...). Capture those too.
    if (
      command.includes("api") && command.includes("POST") &&
      command.includes("/comments") &&
      args.some((a) => a.startsWith("body="))
    ) {
      actions.push("post-comment");
      return Promise.resolve("");
    }
    return Promise.resolve("");
  };
}

// ---------------------------------------------------------------------------
// getLabelLastAddInfo tests
// ---------------------------------------------------------------------------

Deno.test("issue_query - getLabelLastAddInfo returns timestamp of last labeled event", async () => {
  const gh = createGhMock({
    issueTitle: "",
    issueBody: "",
    timeline: [
      {
        event: "labeled",
        label: { name: "work-on" },
        actor: { login: "alice" },
        created_at: "2026-04-23T10:48:04Z",
      },
      {
        event: "unlabeled",
        label: { name: "work-on" },
        actor: { login: "alice" },
      },
      {
        event: "labeled",
        label: { name: "work-on" },
        actor: { login: "alice" },
        created_at: "2026-04-23T20:37:13Z",
      },
    ],
  });

  const info = await getLabelLastAddInfo("owner/repo", 42, "work-on", gh);
  assertEquals(info !== null, true);
  if (info !== null) {
    assertEquals(info.addedBy, "alice");
    // 2026-04-23T20:37:13Z as unix seconds.
    assertEquals(
      info.addedAt,
      Math.floor(Date.parse("2026-04-23T20:37:13Z") / 1000),
    );
  }
});

Deno.test("issue_query - getLabelLastAddInfo returns null when no timestamp present", async () => {
  const gh = createGhMock({
    issueTitle: "",
    issueBody: "",
    timeline: [
      {
        event: "labeled",
        label: { name: "work-on" },
        actor: { login: "alice" },
      },
    ],
  });

  const info = await getLabelLastAddInfo("owner/repo", 42, "work-on", gh);
  assertEquals(info, null);
});

Deno.test("issue_query - getLabelLastAddInfo returns null when label never added", async () => {
  const gh = createGhMock({
    issueTitle: "",
    issueBody: "",
    timeline: [
      {
        event: "labeled",
        label: { name: "refine-issue" },
        actor: { login: "alice" },
        created_at: "2026-04-23T10:48:04Z",
      },
    ],
  });

  const info = await getLabelLastAddInfo("owner/repo", 42, "work-on", gh);
  assertEquals(info, null);
});

// ---------------------------------------------------------------------------
// verifyWorkOnContentIntegrity re-approval scenario (Issue #1561)
// ---------------------------------------------------------------------------

Deno.test(
  "work_on_content_integrity - refreshes snapshot when trusted author re-adds work-on after content change (Issue #1561)",
  async () => {
    const { deps } = createMemoryFs();
    const config = makeConfig();
    const issue = makeIssue();

    // Capture a snapshot at 10:00 with the original refined-issue content.
    const captureIso = "2026-04-23T10:00:00Z";
    const captureUnix = Math.floor(Date.parse(captureIso) / 1000);
    await captureContentSnapshot(
      resolveContentApprovalStateDir(config.workDir),
      "owner/repo",
      issue.number,
      "Old title",
      "Old body before refinement",
      issue.author,
      deps,
    );
    // Overwrite capturedAt to a deterministic time so the comparison is
    // unambiguous — avoids relying on wall-clock timing in the test.
    const state = await loadContentApprovalState(
      resolveContentApprovalStateDir(config.workDir),
      deps,
    );
    const key = `owner/repo|${issue.number}`;
    const snap = state.snapshots[key];
    if (snap) snap.capturedAt = captureUnix;
    const stateJson = JSON.stringify(state, null, 2);
    await deps.writeFile!(
      `${
        resolveContentApprovalStateDir(config.workDir)
      }/.content_approval_state.json`,
      stateJson,
    );

    // Content has since been refined (title + body both differ) and the
    // trusted approver re-added work-on at 20:37 — after the snapshot.
    const actions: string[] = [];
    const gh = createGhMock({
      issueTitle: "Refined title",
      issueBody: "Refined, detailed body",
      timeline: [
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2026-04-23T08:00:00Z",
        },
        {
          event: "unlabeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
        },
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2026-04-23T20:37:13Z",
        },
      ],
      actions,
    });

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      issue,
      config,
      gh,
      undefined,
      deps,
    );

    assertEquals(result, "proceed", "Expected re-approved issue to proceed");
    assertEquals(
      actions.includes("remove-label"),
      false,
      "Must not remove work-on label on a legitimate re-approval",
    );
    assertEquals(
      actions.includes("post-comment"),
      false,
      "Must not post 'modified after approval' comment on a legitimate re-approval",
    );

    // The snapshot should now match the refined content so subsequent
    // verification returns "unchanged".
    const state2 = await loadContentApprovalState(
      resolveContentApprovalStateDir(config.workDir),
      deps,
    );
    const snap2 = state2.snapshots[key];
    assertEquals(snap2 !== undefined, true, "Snapshot must still be present");
    if (snap2) {
      assertEquals(
        snap2.capturedAt > captureUnix,
        true,
        "capturedAt should be refreshed to current time",
      );
    }
  },
);

Deno.test(
  "work_on_content_integrity - still blocks when untrusted modifier tampered before a trusted re-approval timestamp",
  async () => {
    // Belt-and-braces: the label-add timestamp check MUST only trigger for
    // trusted approvers. If someone replays a timeline with an untrusted
    // actor and a later timestamp, the fallback "isAuthorTrusted" check
    // should still block.
    const { deps } = createMemoryFs();
    const config = makeConfig();
    const issue = makeIssue({ author: "attacker" });

    await captureContentSnapshot(
      resolveContentApprovalStateDir(config.workDir),
      "owner/repo",
      issue.number,
      "Original title",
      "Original body",
      "attacker",
      deps,
    );

    const actions: string[] = [];
    const gh = createGhMock({
      issueTitle: "Malicious title",
      issueBody: "Injected instructions",
      editedBy: "attacker",
      timeline: [
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "attacker" },
          created_at: "2026-04-23T22:00:00Z",
        },
      ],
      actions,
    });

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      issue,
      config,
      gh,
      undefined,
      deps,
    );

    assertEquals(
      result,
      "blocked",
      "Untrusted label adder must not bypass the gate",
    );
    // Issue #3964: blocking adds needs-human but never strips the approval.
    assertEquals(actions.includes("remove-label"), false);
    assertEquals(actions.includes("post-comment"), true);
  },
);

Deno.test(
  "work_on_content_integrity - adds needs-human label when blocking (Issue #1740)",
  async () => {
    // Issue #1740: when the integrity check blocks an issue because an
    // untrusted author modified it after approval, the worker must add the
    // `needs-human` label so the issue is not silently ignored.
    const { deps } = createMemoryFs();
    const config = makeConfig();
    const issue = makeIssue({ author: "attacker" });

    await captureContentSnapshot(
      resolveContentApprovalStateDir(config.workDir),
      "owner/repo",
      issue.number,
      "Original title",
      "Original body",
      "attacker",
      deps,
    );

    const actions: string[] = [];
    const addedLabels: string[] = [];
    const gh = createGhMock({
      issueTitle: "Mutated title",
      issueBody: "Mutated body",
      editedBy: "attacker",
      timeline: [
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "attacker" },
          created_at: "2026-04-23T22:00:00Z",
        },
      ],
      actions,
      addedLabels,
    });

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      issue,
      config,
      gh,
      undefined,
      deps,
    );

    assertEquals(result, "blocked");
    assertEquals(
      addedLabels.includes(config.needsHumanLabel),
      true,
      "Expected needs-human label to be added when blocking",
    );
  },
);

Deno.test(
  "work_on_content_integrity - security comment mentions needs-human (Issue #1740)",
  async () => {
    const { deps } = createMemoryFs();
    const config = makeConfig();
    const issue = makeIssue({ author: "attacker" });

    await captureContentSnapshot(
      resolveContentApprovalStateDir(config.workDir),
      "owner/repo",
      issue.number,
      "Original title",
      "Original body",
      "attacker",
      deps,
    );

    const postedBodies: string[] = [];
    const gh = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      // Issue #3715: the attacker is the actor behind the edit.
      if (args[0] === "api" && command.includes("userContentEdits")) {
        return Promise.resolve(JSON.stringify({
          data: {
            repository: {
              issue: {
                userContentEdits: {
                  nodes: [{
                    editedAt: new Date(Date.now() + 3600_000).toISOString(),
                    editor: { login: "attacker" },
                  }],
                },
                timelineItems: { nodes: [] },
              },
            },
          },
        }));
      }
      if (command.includes("api") && command.includes("timeline")) {
        return Promise.resolve(JSON.stringify([
          {
            event: "labeled",
            label: { name: "work-on" },
            actor: { login: "attacker" },
            created_at: "2026-04-23T22:00:00Z",
          },
        ]));
      }
      if (command.includes("issue view") && command.includes("title,body")) {
        return Promise.resolve(
          JSON.stringify({ title: "Mutated", body: "Mutated body" }),
        );
      }
      if (command.includes("issue comment")) {
        const bodyIdx = args.indexOf("--body");
        const body = bodyIdx >= 0 ? args[bodyIdx + 1] : undefined;
        if (body !== undefined) postedBodies.push(body);
        return Promise.resolve("");
      }
      // Issue #2211: escalateToHuman's shim posts comments via REST API.
      if (
        command.includes("api") && command.includes("POST") &&
        command.includes("/comments")
      ) {
        for (let i = 0; i < args.length - 1; i++) {
          if (args[i] === "-f") {
            const f = args[i + 1] ?? "";
            if (f.startsWith("body=")) {
              postedBodies.push(f.slice("body=".length));
            }
          }
        }
        return Promise.resolve("");
      }
      return Promise.resolve("");
    };

    await verifyWorkOnContentIntegrity(
      "owner/repo",
      issue,
      config,
      gh,
      undefined,
      deps,
    );

    assertEquals(postedBodies.length, 1, "Expected exactly one comment posted");
    const firstBody = postedBodies[0] ?? "";
    assertEquals(
      firstBody.includes(config.needsHumanLabel),
      true,
      "Expected security comment to mention the needs-human label",
    );
    // Issue #2211: comment is now posted through escalateToHuman, so the
    // body MUST carry the helper's `**Why:**` and `**Next step:**` markers.
    assertEquals(
      firstBody.includes("**Why:**"),
      true,
      "Expected escalateToHuman `**Why:**` marker in the security comment",
    );
    assertEquals(
      firstBody.includes("**Next step:**"),
      true,
      "Expected escalateToHuman `**Next step:**` marker in the security comment",
    );
  },
);

Deno.test(
  "work_on_content_integrity - does not add needs-human on legitimate re-approval (Issue #1740)",
  async () => {
    // Re-approval path must not trigger the escalation — the worker proceeds
    // and no needs-human label is added.
    const { deps } = createMemoryFs();
    const config = makeConfig();
    const issue = makeIssue();

    const captureIso = "2026-04-23T10:00:00Z";
    const captureUnix = Math.floor(Date.parse(captureIso) / 1000);
    await captureContentSnapshot(
      resolveContentApprovalStateDir(config.workDir),
      "owner/repo",
      issue.number,
      "Old title",
      "Old body",
      issue.author,
      deps,
    );
    const state = await loadContentApprovalState(
      resolveContentApprovalStateDir(config.workDir),
      deps,
    );
    const key = `owner/repo|${issue.number}`;
    const snap = state.snapshots[key];
    if (snap) snap.capturedAt = captureUnix;
    await deps.writeFile!(
      `${
        resolveContentApprovalStateDir(config.workDir)
      }/.content_approval_state.json`,
      JSON.stringify(state, null, 2),
    );

    const actions: string[] = [];
    const addedLabels: string[] = [];
    const gh = createGhMock({
      issueTitle: "Refined title",
      issueBody: "Refined body",
      timeline: [
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2026-04-23T20:37:13Z",
        },
      ],
      actions,
      addedLabels,
    });

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      issue,
      config,
      gh,
      undefined,
      deps,
    );

    assertEquals(result, "proceed");
    assertEquals(
      addedLabels.includes(config.needsHumanLabel),
      false,
      "Re-approval must not add needs-human",
    );
  },
);

Deno.test(
  "work_on_content_integrity - blocks when label-add predates snapshot (no re-approval)",
  async () => {
    // If the last work-on label event is earlier than the snapshot, this
    // cannot be a re-approval — an untrusted modifier changed content and
    // the gate should still trip.
    const { deps } = createMemoryFs();
    const config = makeConfig();
    const issue = makeIssue({ author: "untrusted-user" });

    // Snapshot captured at 15:00
    await captureContentSnapshot(
      resolveContentApprovalStateDir(config.workDir),
      "owner/repo",
      issue.number,
      "Original",
      "Body",
      "untrusted-user",
      deps,
    );
    const state = await loadContentApprovalState(
      resolveContentApprovalStateDir(config.workDir),
      deps,
    );
    const key = `owner/repo|${issue.number}`;
    const snap = state.snapshots[key];
    if (snap) {
      snap.capturedAt = Math.floor(Date.parse("2026-04-23T15:00:00Z") / 1000);
    }
    await deps.writeFile!(
      `${
        resolveContentApprovalStateDir(config.workDir)
      }/.content_approval_state.json`,
      JSON.stringify(state, null, 2),
    );

    const actions: string[] = [];
    const gh = createGhMock({
      issueTitle: "Mutated",
      issueBody: "Body",
      editedBy: "untrusted-user",
      timeline: [
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2026-04-23T10:00:00Z", // earlier than snapshot
        },
      ],
      actions,
    });

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      issue,
      config,
      gh,
      undefined,
      deps,
    );

    assertEquals(result, "blocked");
    // Issue #3964: blocking adds needs-human but never strips the approval.
    assertEquals(actions.includes("remove-label"), false);
  },
);
