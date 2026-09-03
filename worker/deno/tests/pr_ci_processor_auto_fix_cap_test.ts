/**
 * Tests for the auto-fix attempt cap in pr_ci_processor (Issue #3582).
 *
 * Three pushes at one underlying failure must count 1, 2, 3 — even though
 * every push mints a fresh check-run id — and the fourth must not start a
 * Claude run. At the cap the worker applies `needs-human` once and posts a
 * single consolidated summary of all three attempts.
 *
 * Uses Australian English throughout.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import { getAutoFixAttempts } from "../lib/auto_fix_attempt_tracker.ts";
import { pinPromptsToThisCheckout } from "./support/repo_prompts.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
pinPromptsToThisCheckout();

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
      if (args[0] === "pr" && args[1] === "comment") {
        const idx = args.indexOf("--body");
        const body = args[idx + 1];
        if (idx >= 0 && body !== undefined) captured.comments.push(body);
      }
      if (args[0] === "api" && args.includes("-X")) {
        const xIdx = args.indexOf("-X");
        if (args[xIdx + 1] === "POST") {
          const endpoint = String(args[xIdx + 2] ?? "");
          for (let i = 0; i < args.length - 1; i++) {
            if (args[i] !== "-f") continue;
            const field = args[i + 1] ?? "";
            if (endpoint.includes("/labels") && field.startsWith("labels[]=")) {
              captured.labelsAdded.push(field.slice("labels[]=".length));
            }
            if (endpoint.includes("/comments") && field.startsWith("body=")) {
              captured.comments.push(field.slice("body=".length));
            }
          }
        }
      }
      if (args[0] === "issue" && args[1] === "edit") {
        const idx = args.indexOf("--add-label");
        const label = args[idx + 1];
        if (idx >= 0 && label !== undefined) captured.labelsAdded.push(label);
      }
      if (args[0] === "label" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      return Promise.resolve("");
    },
  };
}

const COMPILE_ANNOTATIONS: CheckAnnotation[] = [{
  path: "src/Foo.java",
  start_line: 12,
  message: "error: cannot find symbol Bar",
}];

function makeInput(
  annotations: CheckAnnotation[],
  checkRunId: string,
): CiFixInput {
  return {
    repo: "org/repo",
    prNumber: 77,
    branchName: "issue-77-fix",
    checkRunId,
    checkName: "build",
    encodedAnnotations: btoa(JSON.stringify(annotations)),
  };
}

interface Harness {
  captured: CapturedGh;
  claudeRuns: number;
  processorDeps: CiProcessorDeps;
}

/**
 * Build a harness whose Claude run always "pushes a fix" — the build stays
 * red, so each completed run consumes one attempt.
 */
function makeHarness(stateDir: string, workDir: string): Harness {
  const captured: CapturedGh = { comments: [], labelsAdded: [] };
  const harness = { captured, claudeRuns: 0 } as Harness;

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: ((() => {
      harness.claudeRuns++;
      return Promise.resolve({
        ok: true,
        value: { output: "fixed the import", exitCode: 0, timedOut: false },
      });
    }) as unknown) as ClaudeDeps["runClaudeWithRetry"],
  };

  const deps = createMockDeps({
    claude: mockClaude,
    github: makeMockGithub(captured),
    git: {
      commitAndPushPending: (() =>
        Promise.resolve({
          ok: true,
          value: {
            committedNewChanges: true,
            commitsPushed: 1,
            finalUnpushedCount: 0,
          },
        })) as unknown as GitDeps["commitAndPushPending"],
    },
  });

  harness.processorDeps = {
    logger: makeSilentLogger(),
    deps,
    stateDir,
    workDir,
    // Deterministic: no live GitHub Actions log fetch in tests.
    actionsLogFn: () =>
      Promise.resolve({ kind: "not-applicable", reason: "test" } as const),
  };
  return harness;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("processCiFailure - three pushes on one failure exhaust the budget and the fourth is refused", async () => {
  const tmpDir = await Deno.makeTempDir();
  const stateDir = `${tmpDir}/.ci_check_state`;
  try {
    const harness = makeHarness(stateDir, tmpDir);

    // Three attempts, each with a fresh check-run id (as a real push mints).
    for (const checkRunId of ["1001", "1002", "1003"]) {
      const result = await processCiFailure(
        makeInput(COMPILE_ANNOTATIONS, checkRunId),
        { ...harness.processorDeps, maxAutoFixAttempts: 3 },
      );
      assertEquals(result.ok, true);
    }
    assertEquals(harness.claudeRuns, 3);

    // One signature file, three attempts — the check-run id changed on
    // every push but the signature did not.
    assertEquals((await signatureFiles(stateDir)).length, 1);
    assertEquals(await countAllAttempts(stateDir), 3);

    // Fourth run: no Claude, needs-human once, one consolidated comment.
    const capResult = await processCiFailure(
      makeInput(COMPILE_ANNOTATIONS, "1004"),
      { ...harness.processorDeps, maxAutoFixAttempts: 3 },
    );
    assertEquals(capResult.ok, true);
    if (capResult.ok) {
      assertEquals(capResult.value.processed, false);
      assertStringIncludes(capResult.value.summary, "Auto-fix cap reached");
    }
    assertEquals(harness.claudeRuns, 3, "no fourth auto-fix attempt started");

    assertEquals(
      harness.captured.labelsAdded.filter((l) => l === "needs-human").length,
      1,
      `needs-human applied exactly once; got ${
        harness.captured.labelsAdded.join(",")
      }`,
    );

    const capComments = harness.captured.comments.filter((c) =>
      c.includes("Automatic fix attempts exhausted")
    );
    assertEquals(capComments.length, 1, "exactly one consolidated summary");
    const summary = capComments[0] ?? "";
    assertStringIncludes(summary, "3 automatic fix attempts");
    assertStringIncludes(summary, "build");
    // All three attempts are described in the single comment.
    for (const attempt of ["| 1 |", "| 2 |", "| 3 |"]) {
      assertStringIncludes(summary, attempt);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - a different failure on the same PR keeps its own budget", async () => {
  const tmpDir = await Deno.makeTempDir();
  const stateDir = `${tmpDir}/.ci_check_state`;
  try {
    const harness = makeHarness(stateDir, tmpDir);
    const otherAnnotations: CheckAnnotation[] = [{
      path: "tests/x.ts",
      start_line: 3,
      message: "assertion failed: expected 3 but got 4",
    }];

    await processCiFailure(makeInput(COMPILE_ANNOTATIONS, "2001"), {
      ...harness.processorDeps,
      maxAutoFixAttempts: 3,
    });
    await processCiFailure(makeInput(COMPILE_ANNOTATIONS, "2002"), {
      ...harness.processorDeps,
      maxAutoFixAttempts: 3,
    });
    await processCiFailure(makeInput(otherAnnotations, "2003"), {
      ...harness.processorDeps,
      maxAutoFixAttempts: 3,
    });

    // Two separate signature files: one with two attempts, one with one.
    const counts = await attemptCountsBySignature(stateDir);
    counts.sort();
    assertEquals(counts, [1, 2]);
    assertEquals(harness.claudeRuns, 3);
    assertEquals(harness.captured.labelsAdded.includes("needs-human"), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - infrastructure failures do not consume an attempt", async () => {
  const tmpDir = await Deno.makeTempDir();
  const stateDir = `${tmpDir}/.ci_check_state`;
  try {
    const harness = makeHarness(stateDir, tmpDir);
    const infraAnnotations: CheckAnnotation[] = [{
      path: "",
      start_line: 0,
      message: "connect ETIMEDOUT 10.0.0.1:443 - runner lost connection",
    }];

    for (const checkRunId of ["3001", "3002", "3003", "3004"]) {
      await processCiFailure(makeInput(infraAnnotations, checkRunId), {
        ...harness.processorDeps,
        maxAutoFixAttempts: 3,
      });
    }

    assertEquals(await countAllAttempts(stateDir), 0);
    assertEquals(harness.claudeRuns, 4, "no cap binds on infrastructure blips");
    assertEquals(harness.captured.labelsAdded.includes("needs-human"), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// State inspection helpers
// ---------------------------------------------------------------------------

async function signatureFiles(stateDir: string): Promise<string[]> {
  const signatures: string[] = [];
  try {
    for await (const entry of Deno.readDir(stateDir)) {
      if (entry.isFile && entry.name.endsWith(".autofix.json")) {
        signatures.push(entry.name.slice(0, -".autofix.json".length));
      }
    }
  } catch {
    // Directory absent — no attempts recorded.
  }
  return signatures;
}

async function attemptCountsBySignature(
  stateDir: string,
): Promise<number[]> {
  const counts: number[] = [];
  for (const signature of await signatureFiles(stateDir)) {
    counts.push((await getAutoFixAttempts(stateDir, signature)).length);
  }
  return counts;
}

async function countAllAttempts(stateDir: string): Promise<number> {
  const counts = await attemptCountsBySignature(stateDir);
  return counts.reduce((sum, n) => sum + n, 0);
}
