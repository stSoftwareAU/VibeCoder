/**
 * Regression tests for Issue #3715 (SEC-e9204c7fa81b) — the content-integrity
 * re-baseline decision must trust whoever *made the edit*, not the author
 * recorded when the snapshot was captured.
 *
 * Before the fix, `resolveContentIntegrity` checked
 * `verification.issueAuthor`, so any collaborator editing a trusted author's
 * issue took the "trusted, proceed and re-baseline" branch.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
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

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMemoryFs(): ContentApprovalDeps {
  const files = new Map<string, string>();
  return {
    readFile: (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        return Promise.reject(new Deno.errors.NotFound(`Not found: ${path}`));
      }
      return Promise.resolve(content);
    },
    writeFile: (path: string, content: string) => {
      files.set(path, content);
      return Promise.resolve();
    },
    renameFile: (oldPath: string, newPath: string) => {
      const content = files.get(oldPath);
      if (content === undefined) {
        return Promise.reject(new Error(`Not found: ${oldPath}`));
      }
      files.set(newPath, content);
      files.delete(oldPath);
      return Promise.resolve();
    },
    removeFile: (path: string) => {
      files.delete(path);
      return Promise.resolve();
    },
  };
}

function makeConfig(): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: ["owner/repo"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    workDir: "/tmp/work-integrity-editor-test",
  };
}

function makeIssue(author: string): FilterableIssue {
  return {
    number: 42,
    title: "Fix the bug",
    url: "https://github.com/owner/repo/issues/42",
    assignees: [],
    labels: ["work-on"],
    createdAt: "2026-05-01T00:00:00Z",
    author,
    milestone: "",
  };
}

interface EditorMockOptions {
  /** Current title/body returned by `gh issue view`. */
  title: string;
  body: string;
  /** Login recorded against the most recent body edit, or null for none. */
  editor?: string | null;
  /** When set, the edit-actor GraphQL call rejects with this message. */
  graphqlError?: string;
  actions: string[];
  addedLabels?: string[];
  commentBodies?: string[];
}

function createGhMock(
  opts: EditorMockOptions,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");

    // Edit-actor lookup (Issue #3715). Matched on `userContentEdits` so
    // other GraphQL queries fall through to the branches below.
    if (args[0] === "api" && command.includes("userContentEdits")) {
      opts.actions.push("edit-actor-query");
      if (opts.graphqlError !== undefined) {
        return Promise.reject(new Error(opts.graphqlError));
      }
      // Issue #3964: the edit must post-date the snapshot (captured at real
      // wall-clock time in these tests) to land inside the judged window — a
      // mismatch with zero in-window edits now re-baselines instead.
      const nodes = opts.editor === undefined ? [] : [{
        editedAt: new Date(Date.now() + 3600_000).toISOString(),
        editor: opts.editor === null ? null : { login: opts.editor },
      }];
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

    // Label timeline — no work-on re-approval in these scenarios.
    if (command.includes("api") && command.includes("timeline")) {
      return Promise.resolve(JSON.stringify([
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2026-05-01T08:00:00Z",
        },
      ]));
    }

    if (command.includes("issue view") && command.includes("title,body")) {
      return Promise.resolve(
        JSON.stringify({ title: opts.title, body: opts.body }),
      );
    }

    if (command.includes("--remove-label")) {
      opts.actions.push("remove-label");
      return Promise.resolve("");
    }

    if (
      args[0] === "api" && command.includes("POST") &&
      command.includes("/labels") && args.some((a) => a.startsWith("labels[]="))
    ) {
      opts.actions.push("add-label");
      const match = args.find((a) => a.startsWith("labels[]="));
      if (match) opts.addedLabels?.push(match.slice("labels[]=".length));
      return Promise.resolve("");
    }

    if (
      args[0] === "api" && command.includes("POST") &&
      command.includes("/comments")
    ) {
      opts.actions.push("post-comment");
      for (const arg of args) {
        if (arg.startsWith("body=")) {
          opts.commentBodies?.push(arg.slice("body=".length));
        }
      }
      return Promise.resolve("");
    }

    return Promise.resolve("");
  };
}

async function snapshotAuthor(
  config: WorkerConfig,
  deps: ContentApprovalDeps,
): Promise<string | undefined> {
  const state = await loadContentApprovalState(
    resolveContentApprovalStateDir(config.workDir),
    deps,
  );
  return state.snapshots["owner/repo|42"]?.issueAuthor;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "work_on_content_integrity - blocks an untrusted collaborator editing a trusted author's issue (Issue #3715)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    // The issue — and therefore the snapshot — belongs to the trusted author.
    const issue = makeIssue("alice");

    await captureContentSnapshot(
      resolveContentApprovalStateDir(config.workDir),
      "owner/repo",
      issue.number,
      "Fix the bug",
      "Original body",
      "alice",
      deps,
    );

    const actions: string[] = [];
    const addedLabels: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Injected instructions",
      editor: "mallory",
      actions,
      addedLabels,
      commentBodies,
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
      "An untrusted editor must not inherit the issue author's trust",
    );
    // Issue #3964: blocking adds needs-human but never strips the approval.
    assertEquals(actions.includes("remove-label"), false);
    assertEquals(addedLabels.includes(config.needsHumanLabel), true);
    assertEquals(commentBodies.length, 1);
    assertStringIncludes(commentBodies[0] ?? "", "mallory");
  },
);

Deno.test(
  "work_on_content_integrity - proceeds and re-baselines when a trusted editor made the change (Issue #3715)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    // Issue raised by an untrusted reporter; the trusted author edits it.
    const issue = makeIssue("reporter");

    await captureContentSnapshot(
      resolveContentApprovalStateDir(config.workDir),
      "owner/repo",
      issue.number,
      "Fix the bug",
      "Original body",
      "reporter",
      deps,
    );

    const actions: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Clarified body",
      editor: "alice",
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

    assertEquals(result, "proceed");
    assertEquals(actions.includes("remove-label"), false);
    assertEquals(actions.includes("post-comment"), false);
    assertEquals(
      await snapshotAuthor(config, deps),
      "alice",
      "Re-baselined snapshot should record the trusted editor",
    );
  },
);

Deno.test(
  "work_on_content_integrity - blocks when the edit cannot be attributed to any actor (Issue #3715)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    const issue = makeIssue("alice");

    await captureContentSnapshot(
      resolveContentApprovalStateDir(config.workDir),
      "owner/repo",
      issue.number,
      "Fix the bug",
      "Original body",
      "alice",
      deps,
    );

    const actions: string[] = [];
    const commentBodies: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Rewritten body",
      editor: null, // GitHub recorded the edit but not the actor
      actions,
      commentBodies,
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
    assertStringIncludes(
      commentBodies[0] ?? "",
      "does not attribute",
    );
  },
);

Deno.test(
  "work_on_content_integrity - fails closed without mutating the issue when the editor lookup errors (Issue #3715)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    const issue = makeIssue("alice");

    await captureContentSnapshot(
      resolveContentApprovalStateDir(config.workDir),
      "owner/repo",
      issue.number,
      "Fix the bug",
      "Original body",
      "alice",
      deps,
    );

    const actions: string[] = [];
    const gh = createGhMock({
      title: "Fix the bug",
      body: "Changed body",
      graphqlError: "gh: API rate limit exceeded",
      actions,
    });

    const skipped: Array<{ reason: string }> = [];
    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      issue,
      config,
      gh,
      {
        logIssueSkipped: (_repo: string, _n: number, reason: string) => {
          skipped.push({ reason });
        },
      } as unknown as Parameters<typeof verifyWorkOnContentIntegrity>[4],
      deps,
    );

    assertEquals(result, "blocked");
    assertEquals(
      actions.includes("remove-label"),
      false,
      "A transient lookup failure must not strip the approval label",
    );
    assertEquals(actions.includes("post-comment"), false);
    assertEquals(skipped[0]?.reason, "content-editor-unresolved");
  },
);
