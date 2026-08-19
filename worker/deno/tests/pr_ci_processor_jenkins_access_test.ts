/**
 * Tests for the Jenkins credentials preflight wiring in
 * `processCiFailure` (Issue #3583).
 *
 * A 401/403/404 from the Jenkins log fetch leaves the worker with no
 * build output at all, so it must post the actionable diagnosis and stop
 * — never start a Claude run that guesses at a fix on no evidence. Any
 * other provider failure (a 5xx, an outage) keeps the existing tolerant
 * behaviour.
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
import type { Logger, RepoConfig } from "../types.ts";
import type {
  PrFailureActionResult,
  runPrFailureActions,
} from "../lib/pr_failure_actions.ts";

const TEST_TOKEN = "wiring-test-token-QRS456";

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
            const field = String(args[i + 1] ?? "");
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

const ANNOTATIONS: CheckAnnotation[] = [{
  path: "src/Foo.java",
  start_line: 12,
  message: "error: cannot find symbol Bar",
}];

function makeInput(): CiFixInput {
  return {
    repo: "stSoftwareAU/example",
    prNumber: 42,
    branchName: "issue-42-fix",
    checkRunId: "9001",
    checkName: "Jenkins / build",
    encodedAnnotations: btoa(JSON.stringify(ANNOTATIONS)),
    targetUrl: "https://jenkins.example.com/job/foo/job/Develop/123/",
  };
}

const REPO_CONFIGS: Record<string, RepoConfig> = {
  "stSoftwareAU/example": {
    prFailureActions: [
      { type: "fetch-jenkins-log", jobPath: "foo/job/Develop" },
    ],
  } as unknown as RepoConfig,
};

interface Harness {
  captured: CapturedGh;
  claudeRuns: number;
  processorDeps: CiProcessorDeps;
}

function makeHarness(
  stateDir: string,
  workDir: string,
  dispatcherResult: PrFailureActionResult[],
): Harness {
  const captured: CapturedGh = { comments: [], labelsAdded: [] };
  const harness = { captured, claudeRuns: 0 } as Harness;

  const mockClaude: Partial<ClaudeDeps> = {
    runClaudeWithRetry: ((() => {
      harness.claudeRuns++;
      return Promise.resolve({
        ok: true,
        value: { output: "guessed a fix", exitCode: 0, timedOut: false },
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
            committedNewChanges: false,
            commitsPushed: 0,
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
    repoConfigs: REPO_CONFIGS,
    prFailureActionsFn: (() =>
      Promise.resolve(
        dispatcherResult,
      )) as unknown as typeof runPrFailureActions,
    actionsLogFn: () =>
      Promise.resolve({ kind: "not-applicable", reason: "test" } as const),
  };
  return harness;
}

Deno.test("processCiFailure - Jenkins 403 posts the diagnosis and skips the fix attempt", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const harness = makeHarness(tmpDir, tmpDir, [
      {
        providerId: "jenkins",
        ok: false,
        error:
          "Jenkins log request failed with HTTP 403 Forbidden — the token lacks Job/Read",
      },
    ]);

    const result = await processCiFailure(makeInput(), harness.processorDeps);

    assert(result.ok);
    assertEquals(result.value.processed, false);
    assertEquals(result.value.changesPushed, false);
    assertStringIncludes(result.value.summary, "forbidden");
    assertEquals(harness.claudeRuns, 0, "no fix attempt without evidence");

    assertEquals(
      harness.captured.labelsAdded.filter((l) => l === "needs-human").length,
      1,
    );
    assertEquals(harness.captured.comments.length, 1);
    const comment = harness.captured.comments[0]!;
    assertStringIncludes(comment, "CI log fetch blocked by credentials");
    assertStringIncludes(comment, "HTTP 403");
    assertStringIncludes(comment, "Job/Read");
    assertStringIncludes(comment, "foo/job/Develop");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - unset Jenkins credentials are diagnosed by name", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const harness = makeHarness(tmpDir, tmpDir, [
      {
        providerId: "jenkins",
        ok: false,
        error:
          "Jenkins credentials are not configured: JENKINS_TOKEN is not set",
      },
    ]);

    const result = await processCiFailure(makeInput(), harness.processorDeps);

    assert(result.ok);
    assertEquals(result.value.processed, false);
    assertEquals(harness.claudeRuns, 0);
    const comment = harness.captured.comments[0] ?? "";
    assertStringIncludes(comment, "JENKINS_TOKEN");
    assert(
      !comment.includes(TEST_TOKEN),
      "a credential value must never reach the comment",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("processCiFailure - a Jenkins outage still attempts a fix", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    const harness = makeHarness(tmpDir, tmpDir, [
      {
        providerId: "jenkins",
        ok: false,
        error:
          "Jenkins log request failed with HTTP 503 Service Unavailable — server error",
      },
    ]);

    const result = await processCiFailure(makeInput(), harness.processorDeps);

    assert(result.ok);
    assertEquals(harness.claudeRuns, 1, "non-auth failures stay tolerant");
    assert(
      !harness.captured.comments.some((c) =>
        c.includes("CI log fetch blocked by credentials")
      ),
      "a 5xx outage is not a credentials problem",
    );
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
