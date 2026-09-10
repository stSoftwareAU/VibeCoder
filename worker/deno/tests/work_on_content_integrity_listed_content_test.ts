/**
 * The scan-time content-integrity check reads the listing, not a live view
 * (Issue #1818).
 *
 * `collectWorkOnCandidates` ran `gh issue view --json title,body` for every
 * work-on candidate on every idle re-scan, for issues it then skipped. The
 * listing already carries the body, and the claimed issue is re-verified
 * live at pickup (Issue #3647), so the scan passes what it holds.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assertEquals, assertNotEquals } from "@std/assert";
import { verifyWorkOnContentIntegrityDetailed } from "../lib/work_on_content_integrity.ts";
import type { ContentApprovalDeps } from "../lib/content_approval_tracker.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";

function createMemoryFs(): ContentApprovalDeps {
  const files = new Map<string, string>();
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
    workDir: "/tmp/work-integrity-listed-content-test",
  };
}

function makeIssue(body?: string): FilterableIssue {
  return {
    number: 42,
    title: "Fix the bug",
    url: "https://github.com/owner/repo/issues/42",
    assignees: [],
    labels: ["work-on"],
    createdAt: "2026-04-23T00:00:00Z",
    author: "alice",
    milestone: "",
    ...(body === undefined ? {} : { body }),
  };
}

/** A gh that answers the timeline but refuses every `issue view`. */
function ghWithoutViews(views: string[][]) {
  return (args: string[]): Promise<string> => {
    const command = args.join(" ");
    if (args[0] === "issue" && args[1] === "view") {
      views.push(args);
      return Promise.reject(new Error("gh: GraphQL primary quota exhausted"));
    }
    if (command.includes("timeline")) {
      return Promise.resolve(JSON.stringify([
        {
          event: "labeled",
          label: { name: "work-on" },
          actor: { login: "alice" },
          created_at: "2026-04-23T00:00:00Z",
        },
      ]));
    }
    return Promise.resolve("");
  };
}

Deno.test("content integrity #1818 - with the listing's title and body no live issue view is made", async () => {
  const views: string[][] = [];
  const outcome = await verifyWorkOnContentIntegrityDetailed(
    "owner/repo",
    makeIssue("Body from the listing"),
    makeConfig(),
    ghWithoutViews(views),
    undefined,
    createMemoryFs(),
    undefined,
    undefined,
    { title: "Fix the bug", body: "Body from the listing" },
  );
  assertEquals(views, [], "the scan must not view an issue it already holds");
  assertNotEquals(
    outcome.verdict === "blocked" ? outcome.reason : "",
    "fetch-error",
  );
});

Deno.test("content integrity #1818 - without listed content the live view is still the source (and its failure still blocks)", async () => {
  const views: string[][] = [];
  const outcome = await verifyWorkOnContentIntegrityDetailed(
    "owner/repo",
    makeIssue(),
    makeConfig(),
    ghWithoutViews(views),
    undefined,
    createMemoryFs(),
  );
  assertEquals(views.length, 1);
  assertEquals(outcome, { verdict: "blocked", reason: "fetch-error" });
});
