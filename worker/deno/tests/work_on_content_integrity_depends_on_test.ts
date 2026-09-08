/**
 * Gate-level regression test for Issue #1616 — the worker's own deferral edit
 * must not trip the modified-after-approval gate.
 *
 * On 7 Sep the blocked-deferral path appended
 * `Depends on stSoftwareAU/NEAT-AI#3978` to NEAT-AI-core#593 as `stservice`,
 * a login that is deliberately *not* on `allowedAuthors`. Every scan then read
 * the body as an untrusted edit and logged
 * `[SECURITY] [ISSUE_MODIFIED_AFTER_APPROVAL]`. The digest now ignores
 * exact-form dependency lines, so the gate proceeds without ever asking who
 * edited the issue.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { resolveContentIntegrity } from "../lib/work_on_content_integrity.ts";
import {
  captureContentSnapshot,
  type ContentApprovalDeps,
} from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";

const TITLE = "Fix the bug";
const APPROVED_BODY = "## Summary\n\nApproved specification";
/** Exactly what `recordDependencyInBody` writes on a blocked deferral. */
const DEFERRED_BODY =
  `${APPROVED_BODY}\n\nDepends on stSoftwareAU/NEAT-AI#3978\n`;

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
    workDir: "/tmp/work-integrity-depends-on-test",
  };
}

/**
 * Serves the deferred body and attributes the edit to `stservice`, the fleet
 * login the deferral path runs as. Every mutation is recorded rather than
 * performed, so the assertions can prove the gate touched nothing.
 */
function createGhMock(actions: string[]): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");

    if (args[0] === "api" && command.includes("userContentEdits")) {
      actions.push("edit-actor-query");
      return Promise.resolve(JSON.stringify({
        data: {
          repository: {
            issue: {
              userContentEdits: {
                nodes: [{
                  editedAt: new Date(Date.now() + 3600_000).toISOString(),
                  editor: { login: "stservice" },
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
          actor: { login: "alice" },
          created_at: "2026-05-01T08:00:00Z",
        },
      ]));
    }

    if (command.includes("issue view") && command.includes("title,body")) {
      return Promise.resolve(
        JSON.stringify({ title: TITLE, body: DEFERRED_BODY }),
      );
    }

    if (command.includes("--remove-label")) {
      actions.push("remove-label");
      return Promise.resolve("");
    }

    if (
      args[0] === "api" && command.includes("POST") &&
      command.includes("/labels") && args.some((a) => a.startsWith("labels[]="))
    ) {
      actions.push("add-label");
      return Promise.resolve("");
    }

    if (
      args[0] === "api" && command.includes("POST") &&
      command.includes("/comments")
    ) {
      actions.push("post-comment");
      return Promise.resolve("");
    }

    return Promise.resolve("");
  };
}

Deno.test(
  "work_on_content_integrity - the worker's own deferral edit proceeds without an editor lookup (Issue #1616)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    await captureContentSnapshot(
      resolveContentApprovalStateDir(config.workDir),
      "owner/repo",
      593,
      TITLE,
      APPROVED_BODY,
      "alice",
      deps,
    );

    const actions: string[] = [];
    const logged: string[] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...args: unknown[]) => logged.push(args.join(" "));
    console.warn = (...args: unknown[]) => logged.push(args.join(" "));

    let verdict;
    try {
      verdict = await resolveContentIntegrity({
        repo: "owner/repo",
        issueNumber: 593,
        issueAuthor: "alice",
        currentTitle: TITLE,
        currentBody: DEFERRED_BODY,
        config,
        ghFn: createGhMock(actions),
        approvalLabel: config.workOnLabel,
        captureWhenMissing: false,
        contentDeps: deps,
      });
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
    }

    assertEquals(verdict, { verdict: "proceed" });
    assertEquals(
      actions,
      [],
      "No edit-actor query, comment or label change is warranted",
    );
    assertEquals(
      logged.filter((line) => line.includes("ISSUE_MODIFIED_AFTER_APPROVAL")),
      [],
      "The deferral line must not be reported as a content modification",
    );
  },
);
