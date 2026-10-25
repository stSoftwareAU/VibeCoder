/**
 * Review-fix facts flip check (Issue #4189).
 *
 * Stubs the verifier and the facts resolver. A refused verdict must reach
 * the reply with the #4186 message. A thrown verifier must be reported, not
 * swallowed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { SummaryFacts } from "../lib/summary_facts.ts";
import {
  type BranchOutcomesFactsOutcome,
  prSummaryFactsPath,
} from "../lib/pr_summary_facts.ts";
import type {
  FactsFlipSeams,
  FactsFlipVerdict,
} from "../lib/facts_flip_verifier.ts";
import {
  type PrFeedbackInput,
  type PrFeedbackProcessorDeps,
  processPrFeedback,
  runReviewFixFactsFlip,
} from "../lib/pr_feedback_processor.ts";
import {
  type ClaudeDeps,
  createMockDeps,
  type GitDeps,
  type GitHubDeps,
  type PrDeps,
} from "../lib/issue_worker_wiring.ts";
import type { Logger } from "../types.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";
import { prResponseMessagePath } from "../lib/pr_branch_preparation.ts";

const SOURCE = "lib/m.ts";
const TEST_NAME = "pins the flag";
const REFUSAL =
  `\`${SOURCE}:2\`: no flip of this line turns \`${TEST_NAME}\` red; name a test that fails, or add one`;

function facts(): SummaryFacts {
  return {
    version: 1,
    branchOutcomes: {
      noneAdded: false,
      entries: [{
        path: SOURCE,
        line: 2,
        outcome: "returns early when the flag is set",
        test: "tests/m_test.ts",
        testName: TEST_NAME,
        flipWentRed: "the named test failed",
      }],
    },
  };
}

function validFacts(): BranchOutcomesFactsOutcome {
  return {
    kind: "valid",
    relativePath: "docs/archive/pr-summaries/pr-summary-4189.facts.json",
    facts: facts(),
    rendered: "",
    content: "{}",
  };
}

interface Log {
  level: string;
  message: string;
  context?: Record<string, unknown>;
}

function logger(logs: Log[]) {
  return {
    info: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "info", message, context }),
    warn: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "warn", message, context }),
    error: (message: string, context?: Record<string, unknown>) =>
      logs.push({ level: "error", message, context }),
  };
}

Deno.test("review-fix facts flip - a refused entry is carried in the reply", async () => {
  const logs: Log[] = [];
  const reply = await runReviewFixFactsFlip({
    repoPath: "/repo",
    issueNumber: 4189,
    logger: logger(logs),
    resolveFacts: () => Promise.resolve(validFacts()),
    verifyFactsFlips: () =>
      Promise.resolve([{
        index: 0,
        verdict: { kind: "refused", message: REFUSAL },
      }]),
  });
  assert(reply !== null);
  assertStringIncludes(reply, REFUSAL);
});

Deno.test("review-fix facts flip - an absent facts file skips with a logged reason", async () => {
  const logs: Log[] = [];
  let verified = false;
  const reply = await runReviewFixFactsFlip({
    repoPath: "/repo",
    issueNumber: 4189,
    logger: logger(logs),
    resolveFacts: () => Promise.resolve({ kind: "absent" }),
    verifyFactsFlips: () => {
      verified = true;
      return Promise.resolve([]);
    },
  });
  assertEquals(reply, null);
  assertEquals(verified, false);
  const skipped = logs.find((log) =>
    log.message === "Facts flip check skipped"
  );
  assert(skipped, "expected a skip log");
  assertEquals(skipped.level, "info");
  assertStringIncludes(String(skipped.context?.reason ?? ""), "absent");
});

Deno.test("review-fix facts flip - a facts file that fails to parse is not_checked", async () => {
  const logs: Log[] = [];
  const reason =
    "Branch outcomes facts file docs/archive/pr-summaries/pr-summary-4189.facts.json is invalid: invalid JSON";
  const reply = await runReviewFixFactsFlip({
    repoPath: "/repo",
    issueNumber: 4189,
    logger: logger(logs),
    resolveFacts: () =>
      Promise.resolve({
        kind: "error",
        relativePath: "docs/archive/pr-summaries/pr-summary-4189.facts.json",
        content: "{",
        reason,
      }),
    verifyFactsFlips: () => Promise.resolve([]),
  });
  assert(reply !== null);
  assertStringIncludes(reply, "not checked:");
  assertStringIncludes(reply, reason);
  assertEquals(reply.includes("verified"), false);
});

Deno.test("review-fix facts flip - a thrown verifier is reported, never swallowed", async () => {
  const logs: Log[] = [];
  const reply = await runReviewFixFactsFlip({
    repoPath: "/repo",
    issueNumber: 4189,
    logger: logger(logs),
    resolveFacts: () => Promise.resolve(validFacts()),
    verifyFactsFlips: (
      _facts: SummaryFacts,
      _seams: FactsFlipSeams,
    ): Promise<FactsFlipVerdict[]> => {
      throw new Error("deno exploded");
    },
  });
  assert(reply !== null);
  assertStringIncludes(reply, "not checked:");
  assertStringIncludes(reply, "deno exploded");
  assert(
    logs.some((log) =>
      log.level === "error" && log.message === "Facts flip verifier failed"
    ),
  );
  assertEquals(
    logs.some((log) =>
      log.message.startsWith("WARNING:") || log.message.startsWith("ERROR:")
    ),
    false,
  );
});

Deno.test("review-fix facts flip - the processor calls the check on the push path", async () => {
  const src = await Deno.readTextFile(
    new URL("../lib/pr_feedback_processor.ts", import.meta.url),
  );
  const start = src.indexOf("async function _processFeedbackWithHeartbeat");
  assert(start >= 0);
  const body = src.slice(start);
  const mutation = body.indexOf("runReviewFixMutationCheck(");
  const flip = body.indexOf("runReviewFixFactsFlip(");
  const push = body.indexOf("deps.git.commitAndPushPending");
  assert(mutation > 0);
  assert(flip > mutation);
  assert(push > flip);
});

// ---------------------------------------------------------------------------
// Processor-level: the flip section must not become the agent's reply.
// ---------------------------------------------------------------------------

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const PUSHED_FIX_TEXT =
  "I've pushed a fix for this feedback. Please review the changes.";
const NOT_CHECKED_REASON = "unsupported_test";

function silentLogger(): Logger {
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

function capturingGithub(captured: CapturedGh): Partial<GitHubDeps> {
  return {
    runGhCommand: (args: string[]) => {
      if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
      if (args[0] === "pr" && args[1] === "comment") {
        const idx = args.indexOf("--body");
        if (idx >= 0 && args[idx + 1] !== undefined) {
          captured.comments.push(args[idx + 1] as string);
        }
      }
      if (args[0] === "api" && args.includes("-X")) {
        const xIdx = args.indexOf("-X");
        if (args[xIdx + 1] === "POST") {
          const endpoint = String(args[xIdx + 2] ?? "");
          if (endpoint.includes("/labels")) {
            const fIdx = args.indexOf("-f");
            if (fIdx >= 0) {
              const field = args[fIdx + 1] ?? "";
              if (field.startsWith("labels[]=")) {
                captured.labelsAdded.push(field.slice("labels[]=".length));
              }
            }
          }
          if (endpoint.includes("/comments")) {
            for (let i = 0; i < args.length - 1; i++) {
              if (args[i] === "-f") {
                const field = args[i + 1] ?? "";
                if (field.startsWith("body=")) {
                  captured.comments.push(field.slice("body=".length));
                }
              }
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
      if (args[0] === "label" && args[1] === "list") {
        return Promise.resolve("[]");
      }
      return Promise.resolve("");
    },
  };
}

function processorInput(): PrFeedbackInput {
  return {
    repo: "org/repo",
    prNumber: 4189,
    branchName: "issue-4189-flip",
    commentType: "pr_review",
    commentId: "rv-flip",
    commentBody: "Please address the review findings.",
  };
}

async function writeTestedFacts(workDir: string): Promise<void> {
  const relative = prSummaryFactsPath(4189);
  const path = `${workDir}/${relative}`;
  const slash = path.lastIndexOf("/");
  await Deno.mkdir(path.slice(0, slash), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(facts()));
}

interface ProcessorRun {
  captured: CapturedGh;
  dismissals: string[];
  result: Awaited<ReturnType<typeof processPrFeedback>>;
  responseFile: string | undefined;
}

async function runProcessor(options: {
  pushed: boolean;
}): Promise<ProcessorRun> {
  const captured: CapturedGh = { comments: [], labelsAdded: [] };
  const dismissals: string[] = [];
  const workDir = await Deno.makeTempDir();
  try {
    await writeTestedFacts(workDir);
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() =>
        Promise.resolve({
          ok: true,
          value: { output: "", exitCode: 0, timedOut: false },
        })) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const pr: Partial<PrDeps> = {
      markCommentProcessed: ((
        _repo: string,
        commentType: string,
        commentId: string,
        _prNumber: number | undefined,
        outcome: string,
      ) => {
        dismissals.push(`${commentType}:${commentId}:${outcome}`);
        return Promise.resolve({ ok: true, value: undefined });
      }) as PrDeps["markCommentProcessed"],
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github: capturingGithub(captured),
      pr,
      ...(options.pushed
        ? {
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
        }
        : {}),
      quality: {
        verifyFactsFlips: () =>
          Promise.resolve([{
            index: 0,
            verdict: { kind: "not_checked", reason: NOT_CHECKED_REASON },
          }]),
      },
    });
    const processorDeps: PrFeedbackProcessorDeps = {
      promptsDir: PROMPTS_DIR,
      logger: silentLogger(),
      deps,
      workDir,
      workRoot: workDir,
      ...(options.pushed
        ? {
          verifyPushFn: () =>
            Promise.resolve({
              landed: true,
              localSha: "a".repeat(40),
              remoteSha: "a".repeat(40),
              reason: "verified in test",
            }),
        }
        : {}),
    };
    const result = await processPrFeedback(processorInput(), processorDeps);
    let responseFile: string | undefined;
    try {
      responseFile = await Deno.readTextFile(prResponseMessagePath(workDir));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return { captured, dismissals, result, responseFile };
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
}

Deno.test("review-fix facts flip - a not-checked verdict does not rebut an unanswered review", async () => {
  const { captured, dismissals, result, responseFile } = await runProcessor({
    pushed: false,
  });

  // Issue #4304: still unanswered, so it is charged for the next cycle —
  // never rebutted by the verdict, and never handed to a human.
  assertEquals(captured.labelsAdded.includes("needs-human"), false);
  assertEquals(dismissals.includes("pr_review:rv-flip:rebuttal"), false);
  assertEquals(dismissals.length, 0);
  assertEquals(
    captured.comments.some((comment) =>
      comment.includes("Facts flip verifier:")
    ),
    false,
  );
  assertEquals(responseFile, undefined);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.summary.includes("rebuttal posted"), false);
  }
});

Deno.test("review-fix facts flip - a successful push still reports the verdict", async () => {
  const { captured, dismissals, responseFile } = await runProcessor({
    pushed: true,
  });

  const reply = captured.comments.find((comment) =>
    comment.includes("Facts flip verifier:")
  );
  assert(reply !== undefined, "the push reply must carry the flip verdict");
  assertStringIncludes(reply, PUSHED_FIX_TEXT);
  assertStringIncludes(reply, `not checked: ${NOT_CHECKED_REASON}`);
  assertEquals(dismissals.includes("pr_review:rv-flip:rebuttal"), false);
  assertEquals(dismissals.includes("pr_review:rv-flip:addressed"), true);
  assertEquals(responseFile, undefined);
});
