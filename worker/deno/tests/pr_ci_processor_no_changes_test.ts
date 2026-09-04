/**
 * Tests for the classifier-aware no-changes path in pr_ci_processor (Issue #1691).
 *
 * When Claude reviews a CI failure but pushes nothing, the worker must:
 *   - run classifyCiFailure() on the failing check;
 *   - post a category-specific PR comment;
 *   - add the `needs-human` label only for the `code-fix-required` category;
 *   - never assert "transient or infrastructure".
 *
 * Includes a regression test for the PR #1678 semgrep ReDoS case.
 *
 * Issue #1863: Adds a "Claude self-pushed" case where commitAndPushPending
 * reports zero work but branchHeadChanged returns true, which must take the
 * success reply path.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844)
// — named as a parameter on every call rather than pinned by deleting the
// host's overrides from the shared process environment (Issue #1024).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSilentLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

interface CapturedGh {
  comments: string[];
  labelsAdded: string[];
}

function makeMockGithub(captured: CapturedGh): Partial<GitHubDeps> {
  return {
    runGhCommand: (args: string[]) => {
      // Capture PR comment bodies posted via `gh pr comment`
      if (args[0] === "pr" && args[1] === "comment") {
        const idx = args.indexOf("--body");
        if (idx >= 0 && args[idx + 1] !== undefined) {
          captured.comments.push(args[idx + 1] as string);
        }
      }
      // Issue #2211: capture comments posted via REST API
      // (escalateToHuman's shim uses `api POST /issues/N/comments`).
      if (args[0] === "api" && args.includes("-X")) {
        const xIdx = args.indexOf("-X");
        if (args[xIdx + 1] === "POST") {
          const endpoint = String(args[xIdx + 2] ?? "");
          if (endpoint.includes("/labels")) {
            const fIdx = args.indexOf("-f");
            if (fIdx >= 0) {
              const f = args[fIdx + 1] ?? "";
              if (f.startsWith("labels[]=")) {
                captured.labelsAdded.push(f.slice("labels[]=".length));
              }
            }
          }
          if (endpoint.includes("/comments")) {
            for (let i = 0; i < args.length - 1; i++) {
              if (args[i] === "-f") {
                const f = args[i + 1] ?? "";
                if (f.startsWith("body=")) {
                  captured.comments.push(f.slice("body=".length));
                }
              }
            }
          }
        }
      }
      // Capture label add via gh issue edit fallback
      if (args[0] === "issue" && args[1] === "edit") {
        const idx = args.indexOf("--add-label");
        if (idx >= 0 && args[idx + 1] !== undefined) {
          captured.labelsAdded.push(args[idx + 1] as string);
        }
      }
      // Default JSON returns for label cache list
      if (args[0] === "label" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      return Promise.resolve("");
    },
  };
}

function makeInput(overrides?: Partial<CiFixInput>): CiFixInput {
  const annotations: CheckAnnotation[] = [
    { path: "src/x.ts", start_line: 1, message: "default annotation" },
  ];
  const encoded = btoa(JSON.stringify(annotations));
  return {
    repo: "org/repo",
    prNumber: 99,
    branchName: "issue-99-fix",
    checkRunId: "111",
    checkName: "test",
    encodedAnnotations: encoded,
    ...overrides,
  };
}

/**
 * Build a no-changes scenario: Claude returns the given output but no commits
 * are pushed, so the processor must hit the no-changes branch.
 */
async function runNoChangesScenario(
  input: CiFixInput,
  claudeOutput: string,
): Promise<CapturedGh> {
  const tmpDir = await Deno.makeTempDir();
  try {
    const captured: CapturedGh = { comments: [], labelsAdded: [] };

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: claudeOutput, exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };

    const deps = createMockDeps({
      claude: mockClaude,
      github: makeMockGithub(captured),
      git: {
        // No-changes scenario: nothing to commit, nothing to push.
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 0,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
    };

    const result = await processCiFailure(input, processorDeps);
    assertEquals(result.ok, true);
    return captured;
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Tests — one per classifier category
// ---------------------------------------------------------------------------

/**
 * Issue #579: a claim that the push landed is now made against the REMOTE,
 * not against local state. Tests that assert a successful push therefore say
 * so explicitly — clean local state, and a moved HEAD, are no longer
 * sufficient evidence on their own.
 */
const REMOTE_CONFIRMS_PUSH = () =>
  Promise.resolve({
    landed: true,
    localSha: "f".repeat(40),
    remoteSha: "f".repeat(40),
    reason: "verified in test",
  });

Deno.test("processCiFailure no-changes - code-fix-required adds needs-human and quotes signals", async () => {
  const annotations: CheckAnnotation[] = [
    {
      path: "src/regex.ts",
      start_line: 12,
      message:
        "Detected non-literal regex (detect-non-literal-regexp): possible ReDoS",
    },
  ];
  const input = makeInput({
    checkName: "semgrep",
    encodedAnnotations: btoa(JSON.stringify(annotations)),
  });
  const captured = await runNoChangesScenario(input, "");

  // Comment body: must mention the failing check, name the classifier reason,
  // and must NOT contain "transient".
  assertEquals(captured.comments.length >= 1, true);
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "**semgrep**");
  assertStringIncludes(body, "needs-human");
  assertStringIncludes(body, "Classifier reason");
  // Quote some signal — at minimum the check name should be present.
  assertStringIncludes(body, "check:semgrep");
  assertEquals(body.toLowerCase().includes("transient"), false);
  // Issue #2211: comment is now posted through escalateToHuman, so the
  // body MUST carry the helper's `**Why:**` and `**Next step:**` markers.
  assertStringIncludes(body, "**Why:**");
  assertStringIncludes(body, "**Next step:**");

  // Label: must include needs-human.
  assertEquals(
    captured.labelsAdded.includes("needs-human"),
    true,
    `expected needs-human in labels; got: ${captured.labelsAdded.join(",")}`,
  );
});

Deno.test("processCiFailure no-changes - timing category suggests re-run, no needs-human", async () => {
  const annotations: CheckAnnotation[] = [
    {
      path: "tests/slow.ts",
      start_line: 1,
      message: "Test timed out after 30s",
    },
  ];
  const input = makeInput({
    checkName: "tests",
    encodedAnnotations: btoa(JSON.stringify(annotations)),
  });
  const captured = await runNoChangesScenario(input, "");

  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "**tests**");
  assertStringIncludes(body, "timing");
  assertStringIncludes(body, "re-run");
  assertEquals(body.toLowerCase().includes("transient"), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processCiFailure no-changes - infrastructure category suggests re-run, no needs-human", async () => {
  const annotations: CheckAnnotation[] = [
    {
      path: "deploy.log",
      start_line: 1,
      message: "fatal: connect ETIMEDOUT 140.82.112.6:443",
    },
  ];
  const input = makeInput({
    checkName: "deploy",
    encodedAnnotations: btoa(JSON.stringify(annotations)),
  });
  const captured = await runNoChangesScenario(input, "");

  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "**deploy**");
  assertStringIncludes(body, "infrastructure");
  assertStringIncludes(body, "re-run");
  assertEquals(body.toLowerCase().includes("transient"), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processCiFailure no-changes - unknown category does not assert transience", async () => {
  // Annotation text contains nothing the classifier recognises.
  const annotations: CheckAnnotation[] = [
    {
      path: "x.ts",
      start_line: 1,
      message: "obscure failure with no recognisable markers",
    },
  ];
  const input = makeInput({
    checkName: "custom-check",
    encodedAnnotations: btoa(JSON.stringify(annotations)),
  });
  const captured = await runNoChangesScenario(input, "");

  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "**custom-check**");
  assertStringIncludes(body, "could not determine");
  assertEquals(body.toLowerCase().includes("transient"), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

// ---------------------------------------------------------------------------
// Regression test — PR #1678 semgrep ReDoS dismissed as "transient".
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Issue #1863 — Claude self-pushed during run
// ---------------------------------------------------------------------------

Deno.test("processCiFailure - Claude self-pushed: HEAD moved triggers success reply (Issue #1863)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const captured: CapturedGh = { comments: [], labelsAdded: [] };

    // Claude commits-and-pushes during its own run, so the final-mile
    // commitAndPushPending finds nothing to do.
    //
    // Issue #1863 originally called branchHeadChanged "the authoritative
    // signal that work landed". Issue #579 disproved that: a LOCAL commit
    // moves HEAD too, and PR #549 claimed a push that never happened on
    // exactly this evidence. A moved HEAD now only re-opens the question;
    // the remote answers it, which is what REMOTE_CONFIRMS_PUSH stands in
    // for here.
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Pushed fix", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };

    const deps = createMockDeps({
      claude: mockClaude,
      github: makeMockGithub(captured),
      git: {
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 0,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
        captureBranchHead: (() =>
          Promise.resolve({
            ok: true,
            value: "sha-before",
          })) as unknown as GitDeps["captureBranchHead"],
        // HEAD moved: Claude pushed during its run.
        branchHeadChanged: (() =>
          Promise.resolve({ ok: true, value: true })) as unknown as GitDeps[
            "branchHeadChanged"
          ],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      verifyPushFn: REMOTE_CONFIRMS_PUSH,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(
        result.value.changesPushed,
        true,
        "changesPushed must be true when HEAD moved during the Claude run",
      );
    }

    // Success reply path must be taken — must not include "no changes"
    // dismissive wording or add `needs-human`.
    assertEquals(captured.comments.length >= 1, true);
    const body = captured.comments.at(-1) ?? "";
    assertStringIncludes(body, "pushed a fix");
    assertEquals(
      captured.labelsAdded.includes("needs-human"),
      false,
      "needs-human must not be added when Claude self-pushed a fix",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - genuine no-changes when HEAD unchanged still posts no-changes reply (Issue #1863)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const captured: CapturedGh = { comments: [], labelsAdded: [] };

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };

    const deps = createMockDeps({
      claude: mockClaude,
      github: makeMockGithub(captured),
      git: {
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 0,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
        captureBranchHead: (() =>
          Promise.resolve({
            ok: true,
            value: "sha-before",
          })) as unknown as GitDeps["captureBranchHead"],
        // HEAD did not move — genuine no-op.
        branchHeadChanged: (() =>
          Promise.resolve({ ok: true, value: false })) as unknown as GitDeps[
            "branchHeadChanged"
          ],
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.changesPushed, false);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure no-changes - regression for PR #1678 semgrep ReDoS", async () => {
  const annotations: CheckAnnotation[] = [
    {
      path: "worker/deno/lib/some_regex.ts",
      start_line: 42,
      message:
        "semgrep: blocking code rules fired - detect-non-literal-regexp (possible ReDoS)",
    },
  ];
  const input = makeInput({
    checkName: "Semgrep / scan",
    encodedAnnotations: btoa(JSON.stringify(annotations)),
  });
  const captured = await runNoChangesScenario(input, "");

  const body = captured.comments.at(-1) ?? "";
  // Acceptance criterion: needs-human added, no "transient" wording.
  assertEquals(
    captured.labelsAdded.includes("needs-human"),
    true,
    "needs-human label must be added for the semgrep ReDoS regression case",
  );
  assertEquals(
    body.toLowerCase().includes("transient"),
    false,
    "must not assert transience for a real semgrep finding",
  );
  assertStringIncludes(body, "needs-human");
});

// ---------------------------------------------------------------------------
// Issue #579 — a moved HEAD is not proof the work reached the remote
// ---------------------------------------------------------------------------

Deno.test("processCiFailure - HEAD moved but the remote disagrees: no success claim (Issue #579)", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const captured: CapturedGh = { comments: [], labelsAdded: [] };
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "Pushed fix", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };

    const deps = createMockDeps({
      claude: mockClaude,
      github: makeMockGithub(captured),
      git: {
        // Every local signal says the work landed: nothing left to commit,
        // nothing unpushed, and HEAD moved during the run.
        commitAndPushPending: (() =>
          Promise.resolve({
            ok: true,
            value: {
              committedNewChanges: false,
              commitsPushed: 0,
              finalUnpushedCount: 0,
            },
          })) as unknown as GitDeps["commitAndPushPending"],
        captureBranchHead: (() =>
          Promise.resolve({
            ok: true,
            value: "sha-before",
          })) as unknown as GitDeps["captureBranchHead"],
        branchHeadChanged: (() =>
          Promise.resolve({ ok: true, value: true })) as unknown as GitDeps[
            "branchHeadChanged"
          ],
      },
    });

    const result = await processCiFailure(makeInput(), {
      promptsDir: PROMPTS_DIR,
      logger: makeSilentLogger(),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      // The remote cannot be reached — a broken git credential, which is
      // exactly what happened in Issue #564 and produced PR #549's false
      // claim. Silence from the remote is never evidence of success.
      verifyPushFn: () =>
        Promise.resolve({
          landed: false,
          reason: "could not reach the remote: fatal: could not read Username",
        }),
    });

    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.changesPushed, false);
    const claimed = captured.comments.some((c) => c.includes("I've pushed"));
    assertEquals(
      claimed,
      false,
      `must not claim a push landed; comments: ${
        JSON.stringify(captured.comments)
      }`,
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
