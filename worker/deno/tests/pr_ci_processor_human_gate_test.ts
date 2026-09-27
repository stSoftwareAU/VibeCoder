/**
 * Tests for parking a human-gate CI check (Issue #2727, parent #2683).
 *
 * A failing check whose log carries a `vibe-human-gate: <step>` line waits on
 * a person. The CI-fix lane posts exactly one fleet-marked comment per pull
 * request per gate check naming the step, and then stays silent: no attempt
 * marker, no agent run, no label — on this pass or any later one, whatever
 * the head.
 *
 * The harness keeps the pull request's comments across passes, so a comment
 * one pass posts is what the next pass reads back — the same record every
 * host in the fleet sees.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CiFixInput,
  type CiFixResult,
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
import { buildCiHumanGateMarker } from "../lib/ci_fix_attempt_markers.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

const FLEET_LOGIN = "vibe-bot";
const GATE_CHECK = "bootstrap-applied";
const STEP =
  "apply infra/bootstrap.yaml with AWS SSO, then add the bootstrap-applied label";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** One pull request's state, shared across passes. */
interface PrState {
  /** Comments on the pull request; posted comments are appended. */
  comments: GitHubComment[];
  /** Bodies posted by this harness, in order. */
  posted: string[];
  /** Every label mutation seen, through any route. */
  labelCalls: string[];
  /** How many times the agent ran. */
  agentRuns: number;
  errors: string[];
  /** When set, `pr comment` fails. */
  failPost?: boolean;
  /** When set, the comment read fails. */
  failRead?: boolean;
}

function newPrState(overrides: Partial<PrState> = {}): PrState {
  return {
    comments: [],
    posted: [],
    labelCalls: [],
    agentRuns: 0,
    errors: [],
    ...overrides,
  };
}

function fleetComment(id: number, body: string, author = FLEET_LOGIN) {
  return {
    id,
    body,
    author,
    createdAt: "2026-09-27T03:18:00Z",
    reactions: { thumbsUp: 0, eyes: 0, confused: 0 },
  };
}

function makeLogger(state: PrState): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: (message: string) => state.errors.push(message),
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

function makeGhRunner(state: PrState): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
    if (args[0] === "label" && args[1] === "list") return Promise.resolve("[]");
    // A label mutation: `gh label …`, an `--add-label`/`--remove-label` flag,
    // or a REST call on a `/labels` endpoint — never a body's wording.
    const labelCall = args[0] === "label" ||
      args.some((arg) =>
        arg === "--add-label" || arg === "--remove-label" ||
        (arg.includes("/labels") && !arg.startsWith("body="))
      );
    if (labelCall) state.labelCalls.push(args.slice(0, 4).join(" "));

    const post = (body: string) => {
      state.posted.push(body);
      state.comments.push(fleetComment(1000 + state.posted.length, body));
    };
    if (args[0] === "pr" && args[1] === "comment") {
      if (state.failPost) {
        return Promise.reject(new Error("HTTP 502: Bad Gateway"));
      }
      const idx = args.indexOf("--body");
      if (idx >= 0 && args[idx + 1] !== undefined) post(args[idx + 1]!);
    }
    if (args[0] === "api" && args.includes("POST")) {
      for (let i = 0; i < args.length - 1; i++) {
        const field = args[i + 1] ?? "";
        if (args[i] === "-f" && field.startsWith("body=")) {
          post(field.slice("body=".length));
        }
      }
    }
    return Promise.resolve("");
  };
}

function makeInput(
  checkName: string,
  message: string,
  checkRunId = "111",
): CiFixInput {
  const annotations: CheckAnnotation[] = [
    { path: ".github", start_line: 1, message },
  ];
  return {
    repo: "org/repo",
    prNumber: 1492,
    branchName: "issue-1492-bootstrap",
    checkRunId,
    checkName,
    encodedAnnotations: btoa(JSON.stringify(annotations)),
    baseRef: "main",
  };
}

function gateInput(checkName = GATE_CHECK, step = STEP, runId = "111") {
  return makeInput(checkName, `vibe-human-gate: ${step}`, runId);
}

/** Run one CI-fix pass against the shared pull-request state. */
async function runPass(
  state: PrState,
  input: CiFixInput,
  head = "a".repeat(40),
  fleetLogins: string[] = [FLEET_LOGIN],
): Promise<CiFixResult> {
  const tmpDir = await Deno.makeTempDir();
  try {
    const runGh = makeGhRunner(state);
    const mockClaude: Partial<ClaudeDeps> = {
      runClaudeWithRetry: (() => {
        state.agentRuns++;
        return Promise.resolve({
          ok: true,
          value: { output: "", exitCode: 0, timedOut: false },
        });
      }) as unknown as ClaudeDeps["runClaudeWithRetry"],
    };
    const github: Partial<GitHubDeps> = {
      runGhCommand: runGh,
      ensureLabelExists: ((_repo: string, name: string) => {
        state.labelCalls.push(`ensure ${name}`);
        return Promise.resolve();
      }) as unknown as GitHubDeps["ensureLabelExists"],
      createClient: (() => ({
        ...createMockDeps().github.createClient({} as Logger),
        getIssueComments: () =>
          state.failRead
            ? Promise.reject(new Error("HTTP 500"))
            : Promise.resolve([...state.comments]),
        addLabel: (_r: string, _n: number, label: string) => {
          state.labelCalls.push(`add ${label}`);
          return Promise.resolve();
        },
        removeLabel: (_r: string, _n: number, label: string) => {
          state.labelCalls.push(`remove ${label}`);
          return Promise.resolve();
        },
      })) as unknown as GitHubDeps["createClient"],
    };
    const deps = createMockDeps({
      claude: mockClaude,
      github,
      git: {
        captureBranchHead: (() =>
          Promise.resolve({ ok: true, value: head })) as unknown as GitDeps[
            "captureBranchHead"
          ],
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
      logger: makeLogger(state),
      deps,
      stateDir: `${tmpDir}/.ci_check_state`,
      workDir: tmpDir,
      workRoot: tmpDir,
      ghCommandFn: runGh,
      fleetLogins,
    };
    const result = await processCiFailure(input, processorDeps);
    assert(result.ok, "processCiFailure returned an error");
    return result.value;
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

function assertNoAttemptMarker(state: PrState): void {
  for (const body of state.posted) {
    assertEquals(body.includes("vibe-ci-fix-attempt"), false, body);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test("human gate - the first pass posts exactly one comment naming the step, and nothing else", async () => {
  const state = newPrState();
  const result = await runPass(state, gateInput());

  assertEquals(state.posted.length, 1);
  const body = state.posted[0]!;
  assertStringIncludes(body, `**${GATE_CHECK}**`);
  assertStringIncludes(body, `\` ${STEP} \``);
  assertStringIncludes(
    body,
    `<!-- vibe-ci-human-gate check="${GATE_CHECK}" -->`,
  );
  assertEquals(state.labelCalls, []);
  assertEquals(state.agentRuns, 0);
  assertNoAttemptMarker(state);
  assertEquals(result.processed, true);
  assertEquals(result.changesPushed, false);
});

Deno.test("human gate - second and third passes, one on a new head, stay silent", async () => {
  const state = newPrState();
  await runPass(state, gateInput());
  const second = await runPass(state, gateInput());
  const third = await runPass(
    state,
    gateInput(GATE_CHECK, STEP, "222"),
    "b".repeat(40),
  );

  assertEquals(state.posted.length, 1);
  assertEquals(state.labelCalls, []);
  assertEquals(state.agentRuns, 0);
  assertNoAttemptMarker(state);
  assertEquals(second.processed, true);
  assertEquals(third.processed, true);
});

Deno.test("human gate - a changed step on a later pass still posts nothing", async () => {
  const state = newPrState();
  await runPass(state, gateInput());
  await runPass(state, gateInput(GATE_CHECK, "a different step", "333"));

  assertEquals(state.posted.length, 1);
});

Deno.test("human gate - a gate marker written outside the fleet is ignored", async () => {
  const forged = buildCiHumanGateMarker({ checkName: GATE_CHECK });
  const state = newPrState({
    comments: [fleetComment(1, forged, "drive-by-contributor")],
  });
  await runPass(state, gateInput());
  await runPass(state, gateInput());

  assertEquals(state.posted.length, 1);
  assertStringIncludes(state.posted[0]!, "vibe-ci-human-gate");
});

Deno.test("human gate - two gate checks on one PR get one comment each", async () => {
  const state = newPrState();
  await runPass(state, gateInput());
  await runPass(state, gateInput("release-approved", "approve the release"));
  await runPass(state, gateInput());
  await runPass(state, gateInput("release-approved", "approve the release"));

  assertEquals(state.posted.length, 2);
  assertStringIncludes(state.posted[0]!, `check="${GATE_CHECK}"`);
  assertStringIncludes(state.posted[1]!, `check="release-approved"`);
  assertEquals(state.agentRuns, 0);
});

Deno.test("human gate - a marker-read failure stands down without posting", async () => {
  const state = newPrState({ failRead: true });
  const result = await runPass(state, gateInput());

  assertEquals(result.processed, false);
  assertEquals(state.posted, []);
  assertEquals(state.agentRuns, 0);
  assertEquals(state.labelCalls, []);
});

Deno.test("human gate - an unresolved fleet identity posts nothing and fails loud", async () => {
  const state = newPrState();
  const result = await runPass(state, gateInput(), "a".repeat(40), []);

  assertEquals(result.processed, false);
  assertEquals(state.posted, []);
  assertEquals(state.agentRuns, 0);
  assertEquals(state.labelCalls, []);
  assert(
    state.errors.some((line) =>
      line.includes("Human-gate check not announced")
    ),
    `expected a loud error; got: ${state.errors.join(" | ")}`,
  );
});

Deno.test("human gate - a comment that cannot be posted is unprocessed and records nothing", async () => {
  const state = newPrState({ failPost: true });
  const result = await runPass(state, gateInput());

  assertEquals(result.processed, false);
  assertEquals(state.comments, []);
  assertEquals(state.agentRuns, 0);
  assertEquals(state.labelCalls, []);
  assert(
    state.errors.some((line) => line.includes("human-gate comment")),
    `expected a loud error; got: ${state.errors.join(" | ")}`,
  );

  // The next pass, with posting restored, announces the gate once.
  state.failPost = false;
  await runPass(state, gateInput());
  assertEquals(state.posted.length, 1);
});

Deno.test("human gate - a step carrying backticks and a mention renders inert", async () => {
  const state = newPrState();
  const hostile = "run ``` `x` ``` then ## Heading @someone [link](http://e)";
  await runPass(state, gateInput(GATE_CHECK, hostile));

  assertEquals(state.posted.length, 1);
  const body = state.posted[0]!;
  // The step sits on its own line in a code span whose fence is one longer
  // than the longest backtick run inside it, so neither the heading, the
  // link nor the mention is live Markdown.
  assertStringIncludes(
    body,
    "\n```` run ``` `x` ``` then ## Heading @someone [link](http://e) ````\n",
  );
});

Deno.test("human gate - a non-gate failure on the same PR still takes the cap-and-agent path", async () => {
  const state = newPrState();
  await runPass(state, gateInput());
  await runPass(
    state,
    makeInput(
      "semgrep",
      "semgrep: blocking code rules fired - detect-non-literal-regexp",
      "444",
    ),
  );

  assertEquals(state.agentRuns, 1);
  // The ordinary code-fix escalation still labels the PR — which also proves
  // the harness sees a label call when one is made.
  assert(state.labelCalls.length > 0, "expected the ordinary escalation");
  assertEquals(state.posted.length >= 2, true);
  assertStringIncludes(state.posted.at(-1)!, "<!-- vibe-ci-fix-attempt ");
});
