/**
 * Tests for the CI-fix base-branch deferral (Issue #1880, parent #1861).
 *
 * When the agent reports the failure as pre-existing on the base branch by
 * ending its `.pr_response_message` with a `Depends on owner/repo#N` line,
 * and the base branch's own latest run of the same check is red, the worker
 * must post the diagnosis **once**, record a deferral marker, apply no
 * `needs-human` and charge no attempt. Every weaker reading — a green base,
 * a lookup that errored, a prior deferral whose blocker has since closed —
 * falls through to the ordinary no-changes path, which charges an attempt.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import type { CheckAnnotation } from "../lib/pr_spelling_processor.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import type { GitHubComment, Logger } from "../types.ts";
import type {
  ClaudeDeps,
  GitDeps,
  GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** The fleet login whose markers on the pull request count as the record. */
const FLEET_LOGIN = "vibe-bot";

/** The blocker the agent names. */
const BLOCKER = "org/upstream#149";

/** The agent's `.pr_response_message` for a base-branch failure. */
const AGENT_MESSAGE = [
  "No change required for semgrep — the finding is in the base branch, not " +
  "in this pull request's diff.",
  "",
  "**Inspected:** the semgrep annotation, `lib/some_regex.ts`, and the base " +
  "branch's own run of the same check.",
  "",
  `Depends on ${BLOCKER}`,
].join("\n");

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Everything a scenario run recorded. */
interface Captured {
  comments: string[];
  labelsAdded: string[];
  errors: string[];
  warnings: string[];
}

/** How the stubbed GitHub answers the base-branch and issue-state reads. */
interface StubOptions {
  /** Raw `check-runs` body for the base branch, or a thrower. */
  baseCheckRuns?: string | "error";
  /** State the blocking issue reports. */
  blockerState?: "OPEN" | "CLOSED";
  /** Comments already on the pull request. */
  existingComments?: GitHubComment[];
}

/** A `check-runs` payload naming one completed run of `semgrep`. */
function baseCheckRunsPayload(conclusion: string): string {
  return JSON.stringify({
    check_runs: [
      { id: 7, name: "semgrep", status: "completed", conclusion },
    ],
  });
}

function makeRecordingLogger(captured: Captured): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: (message: string) => captured.warnings.push(message),
    error: (message: string) => captured.errors.push(message),
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

/**
 * One `gh` runner serving every call the processor makes: it captures the
 * comment bodies and labels, and answers the base-branch check-run and
 * issue-state reads the deferral depends on.
 */
function makeGhRunner(
  captured: Captured,
  options: StubOptions,
): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");

    // The base branch's own run of the failing check.
    if (args[0] === "api" && String(args[1] ?? "").includes("/check-runs")) {
      if (options.baseCheckRuns === "error") {
        return Promise.reject(new Error("HTTP 502: Bad Gateway"));
      }
      return Promise.resolve(
        options.baseCheckRuns ?? baseCheckRunsPayload("failure"),
      );
    }

    // The state of the issue a prior deferral names.
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(JSON.stringify({
        number: 149,
        state: options.blockerState ?? "OPEN",
        title: "Base branch is red",
      }));
    }

    if (args[0] === "pr" && args[1] === "comment") {
      const idx = args.indexOf("--body");
      if (idx >= 0 && args[idx + 1] !== undefined) {
        captured.comments.push(args[idx + 1] as string);
      }
    }

    // escalateToHuman posts its comment and label through the REST shim.
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
      if (idx >= 0 && args[idx + 1] !== undefined) {
        captured.labelsAdded.push(args[idx + 1] as string);
      }
    }

    if (args[0] === "label" && args[1] === "list") return Promise.resolve("[]");
    return Promise.resolve("");
  };
}

function makeInput(): CiFixInput {
  const annotations: CheckAnnotation[] = [
    {
      path: "worker/deno/lib/some_regex.ts",
      start_line: 42,
      message:
        "semgrep: blocking code rules fired - detect-non-literal-regexp (possible ReDoS)",
    },
  ];
  return {
    repo: "org/repo",
    prNumber: 150,
    branchName: "issue-150-fix",
    checkRunId: "111",
    checkName: "semgrep",
    encodedAnnotations: btoa(JSON.stringify(annotations)),
    baseRef: "develop",
  };
}

/**
 * Run a no-changes CI-fix scenario: Claude pushes nothing and leaves
 * `responseMessage` in `.pr_response_message`, exactly as the agent would.
 */
async function runDeferralScenario(
  responseMessage: string | undefined,
  options: StubOptions = {},
  input: CiFixInput = makeInput(),
): Promise<Captured> {
  const tmpDir = await Deno.makeTempDir();
  try {
    if (responseMessage !== undefined) {
      await Deno.writeTextFile(
        `${tmpDir}/.pr_response_message`,
        responseMessage,
      );
    }
    const captured: Captured = {
      comments: [],
      labelsAdded: [],
      errors: [],
      warnings: [],
    };
    const runGh = makeGhRunner(captured, options);

    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };

    const github: Partial<GitHubDeps> = {
      runGhCommand: runGh,
      createClient: (() => ({
        ...createMockDeps().github.createClient({} as Logger),
        getIssueComments: () => Promise.resolve(options.existingComments ?? []),
      })) as unknown as GitHubDeps["createClient"],
    };

    const deps = createMockDeps({
      claude: mockClaude,
      github,
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
      },
    });

    const processorDeps: CiProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: makeRecordingLogger(captured),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      workRoot: tmpDir,
      ghCommandFn: runGh,
      fleetLogins: [FLEET_LOGIN],
    };

    const result = await processCiFailure(input, processorDeps);
    assertEquals(result.ok, true);
    return captured;
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("processCiFailure - a Depends on line with a red base defers once, charging no attempt (Issue #1880)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE);

  assertEquals(
    captured.comments.length,
    1,
    `expected exactly one comment; got ${captured.comments.length}`,
  );
  const body = captured.comments[0] ?? "";
  // The agent's own diagnosis, verbatim, naming the blocking issue.
  assertStringIncludes(body, "the finding is in the base branch");
  assertStringIncludes(body, BLOCKER);
  // The classifier trailer still shows how the failure was categorised.
  assertStringIncludes(body, "**Classifier reason:**");
  // The deferral is recorded for the next host to read.
  assertStringIncludes(body, `<!-- vibe-ci-fix-deferred `);
  assertStringIncludes(body, `depends-on="${BLOCKER}"`);
  // No attempt is charged, and no human is paged.
  assertEquals(body.includes("<!-- vibe-ci-fix-attempt "), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processCiFailure - a Depends on line with a green base takes the ordinary path and charges an attempt (Issue #1880)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: baseCheckRunsPayload("success"),
  });

  assertEquals(captured.comments.length >= 1, true);
  const body = captured.comments.at(-1) ?? "";
  // The agent's message is still posted verbatim (Issue #1876) …
  assertStringIncludes(body, "the finding is in the base branch");
  // … but the failure was not deferred: an attempt is charged and the
  // `code-fix-required` classification escalates as it always did.
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertEquals(captured.labelsAdded.includes("needs-human"), true);
});

Deno.test("processCiFailure - a base-branch lookup error takes the ordinary path and is logged loudly (Issue #1880)", async () => {
  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    baseCheckRuns: "error",
  });

  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertEquals(
    captured.errors.some((line) =>
      line.includes("Could not read the base branch's checks")
    ),
    true,
    `expected a loud error about the failed lookup; got: ${
      captured.errors.join(" | ")
    }`,
  );
});

Deno.test("processCiFailure - no base ref means the claim cannot be verified, so the ordinary path runs (Issue #1880)", async () => {
  const { baseRef: _dropped, ...withoutBase } = makeInput();
  const captured = await runDeferralScenario(
    AGENT_MESSAGE,
    {},
    withoutBase as CiFixInput,
  );

  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
});

Deno.test("processCiFailure - a prior deferral on a still-open blocker posts nothing (Issue #1880)", async () => {
  // The marker the first run wrote, fed back as the pull request's history.
  const first = await runDeferralScenario(AGENT_MESSAGE);
  const priorBody = first.comments[0] ?? "";

  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    blockerState: "OPEN",
    existingComments: [
      { id: 1, author: FLEET_LOGIN, body: priorBody, createdAt: "" },
    ] as unknown as GitHubComment[],
  });

  assertEquals(
    captured.comments.length,
    0,
    `expected no second copy of the diagnosis; got: ${
      captured.comments.join(" | ")
    }`,
  );
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
});

Deno.test("processCiFailure - a prior deferral whose blocker has closed falls through to the ordinary path (Issue #1880)", async () => {
  const first = await runDeferralScenario(AGENT_MESSAGE);
  const priorBody = first.comments[0] ?? "";

  const captured = await runDeferralScenario(AGENT_MESSAGE, {
    blockerState: "CLOSED",
    existingComments: [
      { id: 1, author: FLEET_LOGIN, body: priorBody, createdAt: "" },
    ] as unknown as GitHubComment[],
  });

  // Not deferred a second time: the loop fails loud through the attempt cap.
  assertEquals(captured.comments.length >= 1, true);
  const body = captured.comments.at(-1) ?? "";
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
  assertEquals(
    captured.warnings.some((line) =>
      line.includes("is closed and the agent named it again")
    ),
    true,
    `expected the loop-guard warning; got: ${captured.warnings.join(" | ")}`,
  );
});

Deno.test("processCiFailure - no Depends on line is never deferred, however red the base is (Issue #1880)", async () => {
  const captured = await runDeferralScenario(
    "No change required for semgrep — the annotation matches intended behaviour.",
  );

  const body = captured.comments.at(-1) ?? "";
  assertEquals(body.includes("<!-- vibe-ci-fix-deferred "), false);
  assertStringIncludes(body, "<!-- vibe-ci-fix-attempt ");
});
