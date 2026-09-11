/**
 * Tests for the fleet-wide auto-fix attempt cap and comment dedup in
 * pr_ci_processor (Issues #3582, #1879).
 *
 * The cap and the "one comment per failure" dedup are counted from the pull
 * request's own fleet-authored markers, not from a host-local state file, so
 * three attempts are three **across the fleet**. Every test here runs with an
 * empty `stateDir` and asserts nothing is written to it: a regression to
 * host-local state fails immediately.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  formatCiAnnotations,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import type { GitHubComment, Logger } from "../types.ts";
import { computeFailureSignature } from "../lib/auto_fix_attempt_tracker.ts";
import {
  buildCiFixAttemptMarker,
  CI_FIX_ATTEMPT_MARKER_NAME,
  type CiFixAttemptOutcome,
} from "../lib/ci_fix_attempt_markers.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844)
// — named as a parameter on every call rather than pinned by deleting the
// host's overrides from the shared process environment (Issue #1024).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The login the fleet runs as in these tests. */
const FLEET_LOGIN = "stservice";
/** A sibling fleet host — its markers count just as much. */
const SIBLING_LOGIN = "VibeCoderST";
/** The head `captureBranchHead` reports in `createMockDeps`. */
const HEAD_SHA = "0000000000000000000000000000000000000000";
/** A different head, as a new push would produce. */
const OTHER_HEAD = "a".repeat(40);

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
  /** Bodies of every comment posted. */
  comments: string[];
  /** Labels added. */
  labelsAdded: string[];
  /** `[commentId, body]` for every in-place comment edit. */
  edits: Array<[number, string]>;
}

const COMPILE_ANNOTATIONS: CheckAnnotation[] = [{
  path: "src/Foo.java",
  start_line: 12,
  message: "error: cannot find symbol Bar",
}];

const INFRA_ANNOTATIONS: CheckAnnotation[] = [{
  path: "",
  start_line: 0,
  message: "connect ETIMEDOUT 10.0.0.1:443 - runner lost connection",
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

/**
 * The signature the processor computes for one set of annotations.
 *
 * Derived from the same exported helpers the processor uses rather than
 * hardcoded, so a change to either input still fingerprints identically on
 * both sides.
 */
function signatureFor(
  annotations: CheckAnnotation[],
  workDir: string,
): string {
  return computeFailureSignature({
    repo: "org/repo",
    locus: { kind: "pr", number: 77 },
    checkName: "build",
    logExcerpt: `${formatCiAnnotations(annotations)}\n`,
    workspaceRoot: workDir,
  });
}

/** Build a PR comment carrying one fleet CI-fix attempt marker. */
function markerComment(opts: {
  id: number;
  author: string;
  signature: string;
  attempt: number;
  outcome: CiFixAttemptOutcome;
  head?: string;
  diagnosis?: string;
}): GitHubComment {
  const marker = buildCiFixAttemptMarker({
    signature: opts.signature,
    checkName: "build",
    head: opts.head ?? HEAD_SHA,
    attempt: opts.attempt,
    outcome: opts.outcome,
  });
  return {
    id: opts.id,
    author: opts.author,
    body: `${
      opts.diagnosis ?? `Attempt ${opts.attempt} diagnosis`
    }\n\n${marker}`,
    createdAt: new Date().toISOString(),
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
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
 *
 * @param stateDir - Deliberately empty: the cap must not read or write it.
 * @param workDir - Workspace root, stripped from the signature fingerprint.
 * @param prComments - The PR's existing comments the markers are read from.
 */
function makeHarness(
  stateDir: string,
  workDir: string,
  prComments: GitHubComment[] = [],
): Harness {
  const captured: CapturedGh = { comments: [], labelsAdded: [], edits: [] };
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

  const github: Partial<GitHubDeps> = {
    runGhCommand: (args: string[]) => {
      if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
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
    createClient: (logger: Logger) => {
      const base = createMockDeps().github.createClient(logger);
      return {
        ...base,
        getIssueComments: () => Promise.resolve([...prComments]),
        updateComment: (
          _repo: string,
          commentId: number,
          body: string,
        ): Promise<void> => {
          captured.edits.push([commentId, body]);
          const target = prComments.find((c) => c.id === commentId);
          if (target) target.body = body;
          return Promise.resolve();
        },
      };
    },
  };

  const deps = createMockDeps({
    claude: mockClaude,
    github,
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
    promptsDir: PROMPTS_DIR,
    logger: makeSilentLogger(),
    deps,
    stateDir,
    workDir,
    workRoot: workDir,
    fleetLogins: [FLEET_LOGIN, SIBLING_LOGIN],
    maxAutoFixAttempts: 3,
    // Deterministic: no live GitHub Actions log fetch in tests.
    actionsLogFn: () =>
      Promise.resolve({ kind: "not-applicable", reason: "test" } as const),
  };
  return harness;
}

/** Every file the run left in the state directory. */
async function stateDirFiles(stateDir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(stateDir)) names.push(entry.name);
  } catch {
    // Absent directory — nothing written.
  }
  return names;
}

/** No `*.autofix.json` may ever be written again (Issue #1879). */
async function assertNoAutoFixState(stateDir: string): Promise<void> {
  const names = await stateDirFiles(stateDir);
  assertEquals(
    names.filter((n) => n.endsWith(".autofix.json")),
    [],
    `no auto-fix state file may be written; found ${names.join(", ")}`,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("processCiFailure - three fleet-authored markers on the PR exhaust the budget with an empty state dir", async () => {
  const tmpDir = await Deno.makeTempDir();
  const stateDir = `${tmpDir}/.ci_check_state`;
  try {
    const signature = signatureFor(COMPILE_ANNOTATIONS, tmpDir);
    // Two hosts, three attempts between them — the fleet's shared budget.
    const comments: GitHubComment[] = [
      markerComment({
        id: 11,
        author: FLEET_LOGIN,
        signature,
        attempt: 1,
        outcome: "pushed",
        diagnosis: "missing import of Bar",
      }),
      markerComment({
        id: 12,
        author: SIBLING_LOGIN,
        signature,
        attempt: 2,
        outcome: "pushed",
        diagnosis: "wrong package for Bar",
      }),
      markerComment({
        id: 13,
        author: FLEET_LOGIN,
        signature,
        attempt: 3,
        outcome: "no-change",
        diagnosis: "Bar was removed upstream",
      }),
    ];
    const harness = makeHarness(stateDir, tmpDir, comments);

    const result = await processCiFailure(
      makeInput(COMPILE_ANNOTATIONS, "1004"),
      harness.processorDeps,
    );

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.processed, false);
      assertStringIncludes(result.value.summary, "Auto-fix cap reached");
    }
    assertEquals(harness.claudeRuns, 0, "no fourth auto-fix attempt started");
    await assertNoAutoFixState(stateDir);

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
    // Every attempt the PR records is described in that single comment.
    for (
      const diagnosis of [
        "missing import of Bar",
        "wrong package for Bar",
        "Bar was removed upstream",
      ]
    ) {
      assertStringIncludes(summary, diagnosis);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - markers authored outside the fleet do not spend the budget", async () => {
  const tmpDir = await Deno.makeTempDir();
  const stateDir = `${tmpDir}/.ci_check_state`;
  try {
    const signature = signatureFor(COMPILE_ANNOTATIONS, tmpDir);
    const comments = [1, 2, 3].map((attempt) =>
      markerComment({
        id: 20 + attempt,
        author: "drive-by-commenter",
        signature,
        attempt,
        outcome: "pushed",
      })
    );
    const harness = makeHarness(stateDir, tmpDir, comments);

    const result = await processCiFailure(
      makeInput(COMPILE_ANNOTATIONS, "2004"),
      harness.processorDeps,
    );

    assertEquals(result.ok, true);
    assertEquals(
      harness.claudeRuns,
      1,
      "a comment anyone can write must not exhaust the cap",
    );
    assertEquals(harness.captured.labelsAdded.includes("needs-human"), false);
    await assertNoAutoFixState(stateDir);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - a no-change marker on this very head runs no agent and posts nothing", async () => {
  const tmpDir = await Deno.makeTempDir();
  const stateDir = `${tmpDir}/.ci_check_state`;
  try {
    const signature = signatureFor(COMPILE_ANNOTATIONS, tmpDir);
    const comments = [
      markerComment({
        id: 31,
        author: SIBLING_LOGIN,
        signature,
        attempt: 1,
        outcome: "no-change",
        head: HEAD_SHA,
        diagnosis: "the failure is in the base branch",
      }),
    ];
    const harness = makeHarness(stateDir, tmpDir, comments);

    const result = await processCiFailure(
      makeInput(COMPILE_ANNOTATIONS, "3004"),
      harness.processorDeps,
    );

    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value.processed, false);
    assertEquals(harness.claudeRuns, 0, "nothing has changed — no agent run");
    assertEquals(harness.captured.comments, [], "and no second comment");
    assertEquals(harness.captured.edits, [], "nothing to append either");
    await assertNoAutoFixState(stateDir);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - the same failure on a new head edits the existing comment instead of posting again", async () => {
  const tmpDir = await Deno.makeTempDir();
  const stateDir = `${tmpDir}/.ci_check_state`;
  try {
    const signature = signatureFor(COMPILE_ANNOTATIONS, tmpDir);
    // The earlier diagnosis was made against a different head, so the
    // question is re-opened — but the answer belongs in the same comment.
    const comments = [
      markerComment({
        id: 41,
        author: SIBLING_LOGIN,
        signature,
        attempt: 1,
        outcome: "no-change",
        head: OTHER_HEAD,
        diagnosis: "the failure is in the base branch",
      }),
    ];
    const harness = makeHarness(stateDir, tmpDir, comments);
    // The agent produces no fix this time, so the outcome is "no change".
    harness.processorDeps.deps.git.commitAndPushPending = (() =>
      Promise.resolve({
        ok: true,
        value: {
          committedNewChanges: false,
          commitsPushed: 0,
          finalUnpushedCount: 0,
        },
      })) as unknown as GitDeps["commitAndPushPending"];

    const result = await processCiFailure(
      makeInput(COMPILE_ANNOTATIONS, "4004"),
      harness.processorDeps,
    );

    assertEquals(result.ok, true);
    assertEquals(harness.claudeRuns, 1, "a new head is diagnosed afresh");
    assertEquals(harness.captured.edits.length, 1, "one comment edited");
    assertEquals(harness.captured.edits[0]?.[0], 41);
    const edited = harness.captured.edits[0]?.[1] ?? "";
    assertStringIncludes(edited, "the failure is in the base branch");
    assertStringIncludes(edited, 'attempt="2"');
    assertEquals(
      harness.captured.comments.filter((c) =>
        c.includes(CI_FIX_ATTEMPT_MARKER_NAME)
      ),
      [],
      "no second copy of the diagnosis is posted",
    );
    await assertNoAutoFixState(stateDir);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - infrastructure failures are not charged and write no marker", async () => {
  const tmpDir = await Deno.makeTempDir();
  const stateDir = `${tmpDir}/.ci_check_state`;
  try {
    const harness = makeHarness(stateDir, tmpDir, []);

    for (const checkRunId of ["5001", "5002", "5003", "5004"]) {
      await processCiFailure(
        makeInput(INFRA_ANNOTATIONS, checkRunId),
        harness.processorDeps,
      );
    }

    assertEquals(harness.claudeRuns, 4, "no cap binds on infrastructure blips");
    assertEquals(harness.captured.labelsAdded.includes("needs-human"), false);
    assert(
      harness.captured.comments.every((c) =>
        !c.includes(CI_FIX_ATTEMPT_MARKER_NAME)
      ),
      "an uncharged attempt records no marker",
    );
    await assertNoAutoFixState(stateDir);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
