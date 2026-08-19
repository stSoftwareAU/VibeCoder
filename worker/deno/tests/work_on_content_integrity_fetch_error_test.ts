/**
 * Regression tests for Issue #2534 — poison-issue failure mode.
 *
 * `fetchIssueTitleAndBody` (inside `verifyWorkOnContentIntegrity`) awaits an
 * external `gh issue view` call and `JSON.parse`s its output. Previously
 * neither the rejection nor the parse was guarded, so a single issue whose
 * `gh` call rejected (network / rate-limit / non-zero exit) or returned
 * malformed JSON threw an error that escaped the per-issue scan loop and
 * aborted the entire scan.
 *
 * The fix wraps the fetch+parse in a `Result` and treats a failure as a
 * fail-safe skip ("blocked"): one unreadable issue is skipped, the scan
 * continues with the next candidate.
 *
 * Tests exercise `verifyWorkOnContentIntegrity` directly with a `ghFn` that
 * rejects or returns malformed JSON.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import { verifyWorkOnContentIntegrity } from "../lib/work_on_content_integrity.ts";
import type { ContentApprovalDeps } from "../lib/content_approval_tracker.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";

function createMemoryFs(): ContentApprovalDeps {
  const files = new Map<string, string>();
  return {
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
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: ["owner/repo"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    workDir: "/tmp/work-integrity-fetch-error-test",
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

Deno.test(
  "verifyWorkOnContentIntegrity - skips (blocked) instead of throwing when gh issue view rejects (Issue #2534)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    const issue = makeIssue();

    const gh = (_args: string[]): Promise<string> =>
      Promise.reject(new Error("gh: API rate limit exceeded"));

    // Must resolve to "blocked" rather than rejecting.
    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      issue,
      config,
      gh,
      undefined,
      deps,
    );

    assertEquals(result, "blocked");
  },
);

Deno.test(
  "verifyWorkOnContentIntegrity - skips (blocked) instead of throwing when gh output is malformed JSON (Issue #2534)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    const issue = makeIssue();

    // gh exits 0 but emits a partial / non-JSON payload.
    const gh = (_args: string[]): Promise<string> =>
      Promise.resolve("not-json{ truncated");

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      issue,
      config,
      gh,
      undefined,
      deps,
    );

    assertEquals(result, "blocked");
  },
);

Deno.test(
  "verifyWorkOnContentIntegrity - records a fetch-error skip reason on the diagnostics (Issue #2534)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    const issue = makeIssue();

    const skips: Array<{ number: number; reason: string }> = [];
    const diag = {
      logIssueSkipped(
        _repo: string,
        issueNumber: number,
        reason: string,
      ): void {
        skips.push({ number: issueNumber, reason });
      },
      // deno-lint-ignore no-explicit-any
    } as any;

    const gh = (_args: string[]): Promise<string> =>
      Promise.reject(new Error("network down"));

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      issue,
      config,
      gh,
      diag,
      deps,
    );

    assertEquals(result, "blocked");
    assertEquals(skips.length, 1);
    const skip = skips[0];
    assertEquals(skip?.number, 42);
    assertEquals(skip?.reason, "fetch-error");
  },
);

Deno.test(
  "verifyWorkOnContentIntegrity - proceeds normally on first encounter when gh succeeds (Issue #2534 happy path)",
  async () => {
    const deps = createMemoryFs();
    const config = makeConfig();
    const issue = makeIssue();

    // No snapshot exists yet → "no_snapshot" path → capture + proceed.
    const gh = (args: string[]): Promise<string> => {
      const command = args.join(" ");
      if (command.includes("issue view") && command.includes("title,body")) {
        return Promise.resolve(
          JSON.stringify({ title: "Fix the bug", body: "Body text" }),
        );
      }
      return Promise.resolve("");
    };

    const result = await verifyWorkOnContentIntegrity(
      "owner/repo",
      issue,
      config,
      gh,
      undefined,
      deps,
    );

    assertEquals(result, "proceed");
  },
);
