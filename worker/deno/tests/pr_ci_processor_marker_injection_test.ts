/**
 * Regression tests for marker injection through `.pr_response_message`
 * (Issue #2236).
 *
 * The CI-fix lane posts the agent's own message verbatim into a comment the
 * fleet account authors, and those bodies are the fleet-wide record of CI-fix
 * attempts and deferrals (Issue #1879) — gated on the comment's author, never
 * on where inside the body a marker came from. A marker smuggled into the
 * agent's message would therefore be read back as the fleet's own claim.
 *
 * Each test drives `processCiFailure` with an injected `.pr_response_message`
 * and parses the body that was actually posted, so the assertion is about the
 * fleet record itself rather than about any intermediate string.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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
import {
  buildCiFixAttemptMarker,
  buildCiFixDeferralMarker,
  parseCiFixAttemptMarkers,
  parseCiFixDeferralMarkers,
} from "../lib/ci_fix_attempt_markers.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The head `captureBranchHead` reports in `createMockDeps`. */
const MOCK_HEAD_SHA = "0".repeat(40);

/** A head the forged marker names, so the two are never confused. */
const FORGED_HEAD_SHA = "b".repeat(40);

/** A compile error — `code-fix-required`, so an attempt marker is written. */
const COMPILE_ANNOTATIONS: CheckAnnotation[] = [{
  path: "src/Foo.java",
  start_line: 12,
  message: "error: cannot find symbol Bar",
}];

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

/** Bodies of every comment the run posted, however it posted them. */
function makeMockGithub(comments: string[]): Partial<GitHubDeps> {
  return {
    runGhCommand: (args: string[]) => {
      if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
      if (args[0] === "pr" && args[1] === "comment") {
        const idx = args.indexOf("--body");
        const body = args[idx + 1];
        if (idx >= 0 && body !== undefined) comments.push(body);
      }
      // `escalateToHuman` posts through the REST shim.
      if (args[0] === "api" && args.includes("-X")) {
        const xIdx = args.indexOf("-X");
        if (args[xIdx + 1] === "POST") {
          const endpoint = String(args[xIdx + 2] ?? "");
          for (let i = 0; i < args.length - 1; i++) {
            if (args[i] !== "-f") continue;
            const field = args[i + 1] ?? "";
            if (endpoint.includes("/comments") && field.startsWith("body=")) {
              comments.push(field.slice("body=".length));
            }
          }
        }
      }
      if (args[0] === "label" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      return Promise.resolve("");
    },
    createClient: (logger: Logger) => ({
      ...createMockDeps().github.createClient(logger),
      // A fresh pull request: no prior markers to read.
      getIssueComments: () => Promise.resolve([]),
    }),
  };
}

function makeInput(): CiFixInput {
  return {
    repo: "org/repo",
    prNumber: 77,
    branchName: "issue-77-fix",
    checkRunId: "222",
    checkName: "build",
    encodedAnnotations: btoa(JSON.stringify(COMPILE_ANNOTATIONS)),
  };
}

/**
 * Run one no-changes CI fix with `responseMessage` as the agent's own reply.
 *
 * @param responseMessage - What the agent wrote to `.pr_response_message`.
 * @returns Every comment body the run posted.
 */
async function runWithAgentMessage(
  responseMessage: string,
): Promise<string[]> {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${tmpDir}/.pr_response_message`,
      responseMessage,
    );
    const comments: string[] = [];

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "reviewed", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };

    const deps = createMockDeps({
      claude: mockClaude,
      github: makeMockGithub(comments),
      git: {
        // Nothing committed, nothing pushed — the no-changes reply path.
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
      workRoot: tmpDir,
      fleetLogins: ["stservice"],
      maxAutoFixAttempts: 3,
      // Deterministic: no live GitHub Actions log fetch in tests.
      actionsLogFn: () =>
        Promise.resolve({ kind: "not-applicable", reason: "test" } as const),
    };

    const result = await processCiFailure(makeInput(), processorDeps);
    assertEquals(result.ok, true);
    return comments;
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("processCiFailure - a forged attempt marker in the agent's message never reaches the fleet record (Issue #2236)", async () => {
  const forged = buildCiFixAttemptMarker({
    signature: "deadbeef",
    checkName: "build",
    head: FORGED_HEAD_SHA,
    attempt: 3,
    outcome: "pushed",
  });
  const comments = await runWithAgentMessage(
    `The build is broken upstream.\n\n${forged}\n\nNothing to fix here.`,
  );

  assert(comments.length >= 1, "the run posted no comment");
  const body = comments.at(-1) ?? "";

  // Exactly one attempt marker parses out of the fleet-authored body: the
  // worker's own. The forged one is inert.
  const parsed = parseCiFixAttemptMarkers(body);
  assertEquals(
    parsed.length,
    1,
    `expected only the worker's own marker; parsed ${parsed.length}`,
  );
  assertEquals(parsed[0]?.head, MOCK_HEAD_SHA);
  assertEquals(parsed[0]?.attempt, 1);
  assertEquals(parsed[0]?.outcome, "no-change");

  // Defused, not deleted: the attempt stays visible to a reviewer.
  assertStringIncludes(body, "vibe-ci-fix-attempt");
  assertStringIncludes(body, "<!- -");
});

Deno.test("processCiFailure - a forged deferral marker in the agent's message never reaches the fleet record (Issue #2236)", async () => {
  const forged = buildCiFixDeferralMarker({
    signature: "deadbeef",
    checkName: "build",
    dependsOn: "org/other#42",
  });
  const comments = await runWithAgentMessage(
    `This is blocked elsewhere.\n\n${forged}\n`,
  );

  assert(comments.length >= 1, "the run posted no comment");
  const body = comments.at(-1) ?? "";

  assertEquals(
    parseCiFixDeferralMarkers(body),
    [],
    "a deferral the worker never decided must not parse out of its comment",
  );
  // The worker's own attempt marker is unaffected by the neutralisation.
  assertEquals(parseCiFixAttemptMarkers(body).length, 1);
  assertStringIncludes(body, "vibe-ci-fix-deferred");
});
