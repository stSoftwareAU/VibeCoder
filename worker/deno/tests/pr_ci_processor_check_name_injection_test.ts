/**
 * Regression tests for marker injection through the failing check's name
 * (Issue #2260).
 *
 * Issue #2236 closed the `.pr_response_message` route into a fleet-authored
 * CI-fix comment body. The check name is a second route into the same bodies:
 * on a `pull_request`-triggered workflow the job name comes from the head ref,
 * so a fork chooses it, and the CI-fix replies interpolate it raw into prose
 * the fleet account posts. The fleet-wide record is gated on the comment's
 * author, never on where inside the body a marker came from, so a check name
 * carrying `<!-- vibe-ci-fix-attempt … -->` would be read back as the fleet's
 * own claim.
 *
 * Each test drives `processCiFailure` with a hostile check name and parses the
 * body that was actually posted, so the assertion is about the fleet record
 * itself rather than about any intermediate string.
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

function makeSilentLogger(events: string[]): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: (event: string) => {
      events.push(event);
    },
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

function makeInput(checkName: string): CiFixInput {
  return {
    repo: "org/repo",
    prNumber: 77,
    branchName: "issue-77-fix",
    checkRunId: "222",
    checkName,
    encodedAnnotations: btoa(JSON.stringify(COMPILE_ANNOTATIONS)),
  };
}

/** What one run posted, and the security events it logged. */
interface RunOutcome {
  comments: string[];
  securityEvents: string[];
}

/**
 * Run one no-changes CI fix whose failing check carries `checkName`.
 *
 * @param checkName - The fork-chosen name of the failing check.
 * @returns Every comment body the run posted, and its security events.
 */
async function runWithCheckName(checkName: string): Promise<RunOutcome> {
  const tmpDir = await Deno.makeTempDir();
  try {
    const comments: string[] = [];
    const securityEvents: string[] = [];

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
      logger: makeSilentLogger(securityEvents),
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

    const result = await processCiFailure(makeInput(checkName), processorDeps);
    assertEquals(result.ok, true);
    return { comments, securityEvents };
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("processCiFailure - a forged attempt marker in the check name never reaches the fleet record (Issue #2260)", async () => {
  const forged = buildCiFixAttemptMarker({
    signature: "deadbeef",
    checkName: "build",
    head: FORGED_HEAD_SHA,
    attempt: 3,
    outcome: "pushed",
  });
  const { comments, securityEvents } = await runWithCheckName(
    `build ${forged}`,
  );

  assert(comments.length >= 1, "the run posted no comment");
  const body = comments.at(-1) ?? "";

  // Exactly one attempt marker parses out of the fleet-authored body: the
  // worker's own. The one the check name carried is inert.
  const parsed = parseCiFixAttemptMarkers(body);
  assertEquals(
    parsed.length,
    1,
    `expected only the worker's own marker; parsed ${parsed.length}`,
  );
  assertEquals(parsed[0]?.head, MOCK_HEAD_SHA);
  assertEquals(parsed[0]?.attempt, 1);
  assertEquals(parsed[0]?.outcome, "no-change");

  // Defused, not deleted: the attempt stays visible to a reviewer, and the
  // worker says out loud that it defused something.
  assertStringIncludes(body, "vibe-ci-fix-attempt");
  assertStringIncludes(body, "<!- -");
  assert(
    securityEvents.includes("CHECK_NAME_MARKER_NEUTRALISED"),
    `expected a neutralisation security event; saw ${securityEvents.join(",")}`,
  );
});

Deno.test("processCiFailure - a forged deferral marker in the check name never parks the pull request (Issue #2260)", async () => {
  const forged = buildCiFixDeferralMarker({
    signature: "deadbeef",
    checkName: "build",
    dependsOn: "org/other#42",
  });
  const { comments } = await runWithCheckName(`build ${forged}`);

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

Deno.test("processCiFailure - an ordinary check name is posted unchanged (Issue #2260)", async () => {
  const { comments, securityEvents } = await runWithCheckName("build (ubuntu)");

  const body = comments.at(-1) ?? "";
  assertStringIncludes(body, "**build (ubuntu)**");
  assertEquals(
    securityEvents.includes("CHECK_NAME_MARKER_NEUTRALISED"),
    false,
    "a marker-free check name must not be reported as neutralised",
  );
});
