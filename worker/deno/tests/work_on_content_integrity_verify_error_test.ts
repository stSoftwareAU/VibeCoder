/**
 * Tests for the content-integrity verification-error path
 * (Issue #3649, SEC-51c8ba073ef9).
 *
 * `resolveContentIntegrity`'s `case "error"` branch was commented "fail safe"
 * but returned `"proceed"`, so a verification failure blessed the content it
 * had just failed to verify. Its sibling — the fetch-error branch in
 * `verifyWorkOnContentIntegrity` — correctly returns `"blocked"`.
 *
 * A corrupt `.content_approval_state.json` is the way that branch is reached:
 * the file reads back fine but its contents are not valid state, so the
 * approval baseline for *every* tracked issue is unusable. That must block,
 * not silently degrade to "no snapshot → proceed".
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type ContentApprovalDeps,
  resetContentApprovalRunState,
  verifyContentUnchanged,
} from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import { verifyWorkOnContentIntegrity } from "../lib/work_on_content_integrity.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";

const WORK_DIR = "/tmp/work-integrity-verify-error-test";
const STATE_DIR = resolveContentApprovalStateDir(WORK_DIR);
const STATE_PATH = `${STATE_DIR}/.content_approval_state.json`;

/** In-memory `ContentApprovalDeps`, optionally pre-seeded with raw content. */
function createMemoryFs(
  seed: Record<string, string> = {},
): ContentApprovalDeps {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    readFile: (path: string) => {
      const content = files.get(path);
      if (content === undefined) {
        return Promise.reject(
          new Deno.errors.NotFound(`File not found: ${path}`),
        );
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
        return Promise.reject(new Error(`File not found: ${oldPath}`));
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
    workDir: WORK_DIR,
  };
}

function makeIssue(): FilterableIssue {
  return {
    number: 42,
    title: "Fix the bug",
    url: "https://github.com/owner/repo/issues/42",
    assignees: [],
    labels: ["work-on"],
    createdAt: "2026-04-23T00:00:00Z",
    author: "mallory",
    milestone: "",
  };
}

/** `gh issue view --json title,body` succeeds; everything else is empty. */
function makeGh(): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    const command = args.join(" ");
    if (command.includes("issue view") && command.includes("title,body")) {
      return Promise.resolve(
        JSON.stringify({ title: "Fix the bug", body: "Body text" }),
      );
    }
    return Promise.resolve("");
  };
}

// ---------------------------------------------------------------------------
// verifyContentUnchanged — corrupt state is an error, not a missing snapshot
// ---------------------------------------------------------------------------

Deno.test(
  "verifyContentUnchanged - a readable but unparseable state file yields error",
  async () => {
    const deps = createMemoryFs({ [STATE_PATH]: "{ truncated" });

    const result = await verifyContentUnchanged(
      STATE_DIR,
      "owner/repo",
      42,
      "Fix the bug",
      "Body text",
      deps,
    );

    assertEquals(result.status, "error");
  },
);

Deno.test(
  "verifyContentUnchanged - a readable state file of the wrong shape yields error",
  async () => {
    const deps = createMemoryFs({
      [STATE_PATH]: JSON.stringify({ snapshots: "not-an-object" }),
    });

    const result = await verifyContentUnchanged(
      STATE_DIR,
      "owner/repo",
      42,
      "Fix the bug",
      "Body text",
      deps,
    );

    assertEquals(result.status, "error");
  },
);

Deno.test(
  "verifyContentUnchanged - a missing state file is still no_snapshot, not error",
  async () => {
    // Issue #3875: "this store was unusable" is sticky for the run, and a run
    // is one process — which the tests above share. A missing state file is a
    // first encounter only in a run that has not already seen a fault.
    resetContentApprovalRunState();
    const deps = createMemoryFs();

    const result = await verifyContentUnchanged(
      STATE_DIR,
      "owner/repo",
      42,
      "Fix the bug",
      "Body text",
      deps,
    );

    assertEquals(result.status, "no_snapshot");
  },
);

// ---------------------------------------------------------------------------
// resolveContentIntegrity — the error branch must fail closed
// ---------------------------------------------------------------------------

Deno.test(
  "verifyWorkOnContentIntegrity - blocks when the approval state cannot be verified",
  async () => {
    const deps = createMemoryFs({ [STATE_PATH]: "{ truncated" });

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      makeIssue(),
      makeConfig(),
      makeGh(),
      undefined,
      deps,
    );

    assertEquals(result, "blocked");
  },
);

Deno.test(
  "verifyWorkOnContentIntegrity - records a content-check-error skip reason",
  async () => {
    const deps = createMemoryFs({ [STATE_PATH]: "{ truncated" });
    const skips: Array<{ number: number; reason: string }> = [];
    const diag = {
      logIssueSkipped(_repo: string, issueNumber: number, reason: string) {
        skips.push({ number: issueNumber, reason });
      },
      // deno-lint-ignore no-explicit-any
    } as any;

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      makeIssue(),
      makeConfig(),
      makeGh(),
      diag,
      deps,
    );

    assertEquals(result, "blocked");
    assertEquals(skips.length, 1);
    assertEquals(skips[0]?.reason, "content-check-error");
  },
);

Deno.test(
  "verifyWorkOnContentIntegrity - a corrupt state file does not mint a fresh snapshot",
  async () => {
    // Fail-closed must not also overwrite the (unreadable) baseline: doing so
    // would launder the corruption into a valid approval of current content.
    const seed: Record<string, string> = { [STATE_PATH]: "{ truncated" };
    const deps = createMemoryFs(seed);
    const written: string[] = [];
    const spyDeps: ContentApprovalDeps = {
      ...deps,
      writeFile: (path: string, content: string) => {
        written.push(path);
        return deps.writeFile!(path, content);
      },
    };

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      makeIssue(),
      makeConfig(),
      makeGh(),
      undefined,
      spyDeps,
    );

    assertEquals(result, "blocked");
    assert(
      written.length === 0,
      `no snapshot may be captured, wrote: ${written.join(", ")}`,
    );
  },
);

Deno.test(
  "verifyWorkOnContentIntegrity - an intact state file still proceeds (happy path)",
  async () => {
    // Fresh run (Issue #3875): the corrupt-state tests above marked this store
    // unusable for the process they share with this one.
    resetContentApprovalRunState();
    const deps = createMemoryFs({
      [STATE_PATH]: JSON.stringify({ snapshots: {} }),
    });

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      makeIssue(),
      makeConfig(),
      makeGh(),
      undefined,
      deps,
    );

    assertEquals(result, "proceed");
  },
);
