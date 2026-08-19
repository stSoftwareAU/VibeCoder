/**
 * Tests for the unconfigured content-approval store (Issue #3874).
 *
 * `resolveContentApprovalStateDir` yields `""` whenever `config.workDir` does
 * not name a directory — unset, whitespace-only, or `/`. Both halves of the
 * store used to degenerate quietly on that sentinel: the read short-circuited
 * to an empty state and the write became a no-op, so every issue verified as
 * `no_snapshot` and proceeded. The result was indistinguishable from a genuine
 * first encounter, which disarmed the TOCTOU gate fleet-wide.
 *
 * "The store is not configured" must now travel its own channel: the read
 * fails closed and the integrity gate blocks with a distinct
 * `[SECURITY] [CONTENT_STORE_UNCONFIGURED]` marker.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type ContentApprovalDeps,
  readContentApprovalState,
  saveContentApprovalState,
  verifyContentUnchanged,
} from "../lib/content_approval_tracker.ts";
import { resolveContentApprovalStateDir } from "../lib/content_approval_state_dir.ts";
import { verifyWorkOnContentIntegrity } from "../lib/work_on_content_integrity.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { WorkerConfig } from "../types.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";

/** The work directories that resolve to no store at all. */
const UNCONFIGURED_WORK_DIRS: Array<[label: string, workDir: string]> = [
  ["unset", ""],
  ["whitespace-only", "   "],
  ["tab and newline", "\t\n"],
  ["root", "/"],
  ["repeated root slashes", "///"],
];

function makeConfig(workDir: string): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: ["owner/repo"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    workDir,
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
    author: "alice",
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

/** Run `fn` with console output captured rather than printed. */
async function captureConsole(
  fn: () => Promise<void>,
): Promise<{ warnings: string[]; errors: string[] }> {
  const warnings: string[] = [];
  const errors: string[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
  return { warnings, errors };
}

// ---------------------------------------------------------------------------
// resolveContentApprovalStateDir — every unconfigured shape yields no store
// ---------------------------------------------------------------------------

for (const [label, workDir] of UNCONFIGURED_WORK_DIRS) {
  Deno.test(
    `resolveContentApprovalStateDir - a ${label} workDir yields no store`,
    () => {
      assertEquals(resolveContentApprovalStateDir(workDir), "");
    },
  );
}

Deno.test(
  "resolveContentApprovalStateDir - a configured workDir still yields a store",
  () => {
    assertEquals(
      resolveContentApprovalStateDir("  /home/vibe/auto-issue-work  "),
      "/home/vibe/auto-issue-work-approval-state",
    );
  },
);

// ---------------------------------------------------------------------------
// The store halves fail loud rather than degenerating
// ---------------------------------------------------------------------------

Deno.test(
  "readContentApprovalState - an unconfigured store is an error, not an empty state",
  async () => {
    const result = await readContentApprovalState("");

    assertEquals(result.ok, false);
    assert(
      !result.ok && /not configured/i.test(result.error.message),
      "the reason must name the misconfiguration",
    );
  },
);

Deno.test(
  "saveContentApprovalState - an unconfigured store is an error, not a no-op",
  async () => {
    const result = await saveContentApprovalState("", { snapshots: {} });

    assertEquals(result.ok, false);
  },
);

Deno.test(
  "verifyContentUnchanged - an unconfigured store yields error, not no_snapshot",
  async () => {
    const result = await verifyContentUnchanged(
      "",
      "owner/repo",
      42,
      "Fix the bug",
      "Body text",
    );

    assertEquals(result.status, "error");
  },
);

// ---------------------------------------------------------------------------
// The integrity gate blocks and says why
// ---------------------------------------------------------------------------

for (const [label, workDir] of UNCONFIGURED_WORK_DIRS) {
  Deno.test(
    `verifyWorkOnContentIntegrity - blocks when workDir is ${label}`,
    async () => {
      const skips: string[] = [];
      const diag = {
        logIssueSkipped(_repo: string, _issueNumber: number, reason: string) {
          skips.push(reason);
        },
        // deno-lint-ignore no-explicit-any
      } as any;

      let result: "proceed" | "blocked" | undefined;
      const { warnings, errors } = await captureConsole(async () => {
        result = await verifyWorkOnContentIntegrity(
          "owner/repo",
          makeIssue(),
          makeConfig(workDir),
          makeGh(),
          diag,
        );
      });

      assertEquals(result, "blocked");
      assertEquals(skips, ["content-store-unconfigured"]);
      assert(
        errors.some((line) => line.includes("[CONTENT_STORE_UNCONFIGURED]")),
        `expected a CONTENT_STORE_UNCONFIGURED marker, got: ${
          errors.join(" | ")
        }`,
      );
      assert(
        !warnings.some((line) => line.includes("[NO_CONTENT_SNAPSHOT]")),
        "an unconfigured store must not read as a first encounter",
      );
    },
  );
}

Deno.test(
  "verifyWorkOnContentIntegrity - an unconfigured store captures no snapshot",
  async () => {
    const written: string[] = [];
    const deps: ContentApprovalDeps = {
      readFile: () =>
        Promise.reject(new Deno.errors.NotFound("no state file here")),
      writeFile: (path: string) => {
        written.push(path);
        return Promise.resolve();
      },
      renameFile: () => Promise.resolve(),
      removeFile: () => Promise.resolve(),
    };

    let result: "proceed" | "blocked" | undefined;
    await captureConsole(async () => {
      result = await verifyWorkOnContentIntegrity(
        "owner/repo",
        makeIssue(),
        makeConfig(""),
        makeGh(),
        undefined,
        deps,
      );
    });

    assertEquals(result, "blocked");
    assertEquals(
      written,
      [],
      "a store that cannot be read must not be written either",
    );
  },
);
