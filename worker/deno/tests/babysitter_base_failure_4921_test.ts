/**
 * Tests for `classifyBaseRedFailures`, the babysitter's base-branch failure
 * check (Issue #4921).
 *
 * The babysitter defers a failed-CI pull request only when every failing check
 * is verified red on the base with the same failure. Each repair case builds an
 * otherwise base-red fixture and lets one rule refuse it, so the reason names
 * that rule. The `gh` stub answers only the exact endpoints and jq filters that
 * `ci_base_branch_check.ts` and the lib send, with the jq-shaped payloads those
 * filters produce, and rejects every other call.
 *
 * Uses Australian English throughout (behaviour, normalise, unreadable).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type BaseFailureDecision,
  classifyBaseRedFailures,
  confirmBaseFailureFixed,
} from "../lib/babysitter_base_failure.ts";
import type {
  ActionsLogOptions,
  ActionsLogOutcome,
} from "../lib/github_actions_log_fetcher.ts";

const REPO = "org/repo";
const BASE_REF = "main";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_PATH = ".github/workflows/ci.yml";
const ACTIONS_APP = "github-actions";

/** The jq filters the real calls send; the stub answers only these. */
const HEAD_RUNS_JQ =
  "{total: .total_count, runs: [.check_runs[] | {id, name, conclusion}]}";
const BASE_RUNS_JQ =
  "{check_runs: [.check_runs[] | {id, name, status, conclusion, head_sha, app_slug: .app.slug, details_url}]}";
const IDENTITY_JQ = "{name, app_slug: .app.slug, details_url}";

const PARSER_FAILURE =
  "2026-11-01T10:00:00Z src/parser.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\n";
const RENDER_FAILURE =
  "2026-11-01T10:00:00Z src/render.ts(4,2): error TS2322: Type 'boolean' is not assignable to type 'string'.\n";
const OTHER_FAILURE =
  "2026-11-02T10:00:00Z src/bar.ts(3,1): error TS2304: Cannot find name 'widget'.\n";

/** One failing (or passing) check, as the head and base both report it. */
interface CheckSpec {
  name: string;
  headConclusion: "failure" | "success";
  /** `cancelled` reads as no verdict; `startup_failure` reads as unavailable. */
  baseConclusion: "success" | "failure" | "cancelled" | "startup_failure";
  /** The failure text the pull request's own log holds. */
  prFailure: string;
  /** The failure text the base run's log holds. */
  baseFailure: string;
}

/** A check red on the head and red on the base with the same failure. */
function redCheck(name: string, failure = PARSER_FAILURE): CheckSpec {
  return {
    name,
    headConclusion: "failure",
    baseConclusion: "failure",
    prFailure: failure,
    baseFailure: failure,
  };
}

/** Run and workflow ids for the check at `index`, kept apart per side. */
interface Ids {
  prRun: number;
  prWorkflow: number;
  prJob: number;
  baseRun: number;
  baseWorkflow: number;
  baseJob: number;
}

function idsOf(index: number): Ids {
  return {
    prRun: 1000 + index,
    prWorkflow: 2000 + index,
    prJob: 3000 + index,
    baseRun: 4000 + index,
    baseWorkflow: 5000 + index,
    baseJob: 6000 + index,
  };
}

function detailsUrl(workflowRun: number, job: number): string {
  return `https://github.com/${REPO}/actions/runs/${workflowRun}/job/${job}`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function key(endpoint: string, jq: string): string {
  return JSON.stringify([endpoint, jq]);
}

function unexpected(args: string[]): Error {
  return new Error(`unexpected gh call: ${JSON.stringify(args)}`);
}

interface StubOptions {
  /** The `total_count` the head's check-run page reports. */
  total?: number;
  /** When set, reading the head's check runs rejects with this message. */
  headError?: string;
}

/**
 * A `gh` runner answering the exact calls the lib makes. Each answer is the
 * body `gh api <endpoint> --jq <filter>` prints: a raw string for `.sha` and
 * `.path`, and compact JSON for the object filters.
 */
function ghStub(
  specs: CheckSpec[],
  options: StubOptions = {},
): (args: string[]) => Promise<string> {
  const headEndpoint =
    `repos/${REPO}/commits/${HEAD_SHA}/check-runs?per_page=100`;
  const answers = new Map<string, string>();
  const answer = (endpoint: string, jq: string, body: string): void => {
    answers.set(key(endpoint, jq), body);
  };

  answer(
    headEndpoint,
    HEAD_RUNS_JQ,
    json({
      total: options.total ?? specs.length,
      runs: specs.map((spec, i) => ({
        id: idsOf(i).prRun,
        name: spec.name,
        conclusion: spec.headConclusion,
      })),
    }),
  );
  answer(`repos/${REPO}/commits/${BASE_REF}`, ".sha", `${BASE_SHA}\n`);
  answer(
    `repos/${REPO}/commits/${BASE_REF}/check-runs?per_page=100`,
    BASE_RUNS_JQ,
    json({
      check_runs: specs.map((spec, i) => {
        const ids = idsOf(i);
        return {
          id: ids.baseRun,
          name: spec.name,
          status: "completed",
          conclusion: spec.baseConclusion,
          head_sha: BASE_SHA,
          app_slug: ACTIONS_APP,
          details_url: detailsUrl(ids.baseWorkflow, ids.baseJob),
        };
      }),
    }),
  );
  specs.forEach((spec, i) => {
    const ids = idsOf(i);
    answer(
      `repos/${REPO}/check-runs/${ids.prRun}`,
      IDENTITY_JQ,
      json({
        name: spec.name,
        app_slug: ACTIONS_APP,
        details_url: detailsUrl(ids.prWorkflow, ids.prJob),
      }),
    );
    answer(
      `repos/${REPO}/actions/runs/${ids.prWorkflow}`,
      ".path",
      `${WORKFLOW_PATH}\n`,
    );
    answer(
      `repos/${REPO}/actions/runs/${ids.baseWorkflow}`,
      ".path",
      `${WORKFLOW_PATH}\n`,
    );
  });

  return async (args: string[]): Promise<string> => {
    const [verb, endpoint, flag, jq] = args;
    if (
      verb !== "api" || flag !== "--jq" || endpoint === undefined ||
      jq === undefined
    ) {
      throw unexpected(args);
    }
    if (options.headError !== undefined && endpoint === headEndpoint) {
      throw new Error(options.headError);
    }
    const body = answers.get(key(endpoint, jq));
    if (body === undefined) throw unexpected(args);
    return body;
  };
}

type LogFn = (opts: ActionsLogOptions) => Promise<ActionsLogOutcome>;

/**
 * A log fetcher answering the pull request's failure for its check-run id and
 * the base run's failure for the base run id, and rejecting any other id.
 */
function logStub(specs: CheckSpec[]): LogFn {
  const byRun = new Map<string, string>();
  specs.forEach((spec, i) => {
    const ids = idsOf(i);
    byRun.set(String(ids.prRun), spec.prFailure);
    byRun.set(String(ids.baseRun), spec.baseFailure);
  });
  return (opts: ActionsLogOptions): Promise<ActionsLogOutcome> => {
    const excerpt = byRun.get(opts.checkRunId);
    if (excerpt === undefined) {
      return Promise.reject(new Error(`unexpected log for ${opts.checkRunId}`));
    }
    return Promise.resolve({
      kind: "excerpt",
      providerId: "github-actions",
      jobId: 1,
      excerpt,
    });
  };
}

interface Scenario {
  specs: CheckSpec[];
  rollup?: ReadonlyArray<{ state?: string; conclusion?: string }>;
  stub?: StubOptions;
  actionsLogFn?: LogFn;
}

function classify(scenario: Scenario): Promise<BaseFailureDecision> {
  return classifyBaseRedFailures({
    repo: REPO,
    headSha: HEAD_SHA,
    baseRef: BASE_REF,
    rollup: scenario.rollup ?? [],
    ghFn: ghStub(scenario.specs, scenario.stub),
    actionsLogFn: scenario.actionsLogFn ?? logStub(scenario.specs),
  });
}

Deno.test("confirmBaseFailureFixed accepts a matching red merge-base check only after the newer base is green (Issue #4943)", async () => {
  const currentBase = "d".repeat(40);
  const mergeBase = "c".repeat(40);
  const tree = "e".repeat(40);
  const gh = async (args: string[]): Promise<string> => {
    const endpoint = args[1] ?? "";
    const jq = args[args.indexOf("--jq") + 1] ?? "";
    if (endpoint === `repos/${REPO}/check-runs/123`) {
      return jq === ".head_sha"
        ? `${HEAD_SHA}\n`
        : json({
          name: "Unit tests",
          app_slug: ACTIONS_APP,
          details_url: detailsUrl(2000, 1),
        });
    }
    if (endpoint === `repos/${REPO}/actions/runs/2000` ||
      endpoint === `repos/${REPO}/actions/runs/4000` ||
      endpoint === `repos/${REPO}/actions/runs/5000`) {
      return `${WORKFLOW_PATH}\n`;
    }
    if (endpoint === `repos/${REPO}/commits/${BASE_REF}`) {
      return `${currentBase}\n`;
    }
    if (endpoint === `repos/${REPO}/commits/${BASE_REF}/check-runs?per_page=100`) {
      return json({
        check_runs: [{
          id: 9001,
          name: "Unit tests",
          status: "completed",
          conclusion: "success",
          head_sha: currentBase,
          app_slug: ACTIONS_APP,
          details_url: detailsUrl(5000, 1),
        }],
      });
    }
    if (endpoint === `repos/${REPO}/compare/${currentBase}...${HEAD_SHA}`) {
      return `${mergeBase}\n`;
    }
    if (endpoint === `repos/${REPO}/commits/${mergeBase}`) {
      return jq === ".sha" ? `${mergeBase}\n` : `${tree}\n`;
    }
    if (endpoint === `repos/${REPO}/commits/${mergeBase}/check-runs?per_page=100`) {
      return json({
        check_runs: [{
          id: 4001,
          name: "Unit tests",
          status: "completed",
          conclusion: "failure",
          head_sha: mergeBase,
          app_slug: ACTIONS_APP,
          details_url: detailsUrl(4000, 1),
        }],
      });
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  const result = await confirmBaseFailureFixed({
    repo: REPO,
    baseRef: BASE_REF,
    headSha: HEAD_SHA,
    checkRunId: "123",
    checkName: "Unit tests",
    ghFn: gh,
    actionsLogFn: (input) => Promise.resolve({
      kind: "excerpt",
      providerId: "github-actions",
      jobId: 1,
      excerpt: input.checkRunId === "123" ? PARSER_FAILURE : PARSER_FAILURE,
    }),
  });
  assertEquals(result.confirmed, true, result.reason);
  assertStringIncludes(result.reason, "same signature");
  assertStringIncludes(result.reason, mergeBase);
});

/** A `repair` decision, failing the test on any other kind. */
function repairOf(
  decision: BaseFailureDecision,
): Extract<BaseFailureDecision, { kind: "repair" }> {
  if (decision.kind !== "repair") {
    throw new Error(`expected repair, got ${decision.kind}`);
  }
  return decision;
}

/**
 * The reason of a `repair` decision that is not a green base run: such a
 * reading must not prove that a base fix landed (Issue #4943).
 */
function reasonOf(decision: BaseFailureDecision): string {
  const repair = repairOf(decision);
  assertEquals(
    repair.repairCheck,
    undefined,
    `only a green base run identifies a candidate check: ${repair.reason}`,
  );
  return repair.reason;
}

/** A `gh` runner that must never be reached. */
function unusedGh(): Promise<string> {
  return Promise.reject(new Error("gh must not be called"));
}

Deno.test("classifyBaseRedFailures - defers when the one failing check is red on the base with the same failure", async () => {
  const decision = await classify({ specs: [redCheck("Unit tests")] });
  assertEquals(decision, {
    kind: "defer",
    checks: [{ name: "Unit tests", baseRunId: idsOf(0).baseRun }],
  });
});

Deno.test("classifyBaseRedFailures - defers when every one of two failing checks is red on the base with the same failure", async () => {
  const decision = await classify({
    specs: [redCheck("Unit tests"), redCheck("Render", RENDER_FAILURE)],
  });
  assertEquals(decision, {
    kind: "defer",
    checks: [
      { name: "Unit tests", baseRunId: idsOf(0).baseRun },
      { name: "Render", baseRunId: idsOf(1).baseRun },
    ],
  });
});

Deno.test("classifyBaseRedFailures - a green current base identifies the check but does not prove a base fix (Issue #4943)", async () => {
  const decision = await classify({
    specs: [{ ...redCheck("Unit tests"), baseConclusion: "success" }],
  });
  const repair = repairOf(decision);
  assertStringIncludes(repair.reason, "is green, not red");
  assertEquals(repair.repairCheck, {
    name: "Unit tests",
    headRunId: idsOf(0).prRun,
  });
});

Deno.test("classifyBaseRedFailures - a base run with no verdict (cancelled) repairs without a candidate check (Issue #4943)", async () => {
  const decision = await classify({
    specs: [{ ...redCheck("Unit tests"), baseConclusion: "cancelled" }],
  });
  assertStringIncludes(reasonOf(decision), "is no-run, not red");
});

Deno.test("classifyBaseRedFailures - a base run with an unavailable conclusion repairs without a candidate check (Issue #4943)", async () => {
  const decision = await classify({
    specs: [{ ...redCheck("Unit tests"), baseConclusion: "startup_failure" }],
  });
  assertStringIncludes(reasonOf(decision), "is unavailable, not red");
});

Deno.test("classifyBaseRedFailures - repairs when the base log shows a different failure", async () => {
  const decision = await classify({
    specs: [{ ...redCheck("Unit tests"), baseFailure: OTHER_FAILURE }],
  });
  assertStringIncludes(reasonOf(decision), "shows a different failure");
});

Deno.test("classifyBaseRedFailures - repairs the whole failure when one of two failing checks is not red on the base", async () => {
  const decision = await classify({
    specs: [
      redCheck("Unit tests"),
      { ...redCheck("Lint", RENDER_FAILURE), baseConclusion: "success" },
    ],
  });
  const repair = repairOf(decision);
  assertStringIncludes(
    repair.reason,
    'the base\'s run of "Lint" is green, not red',
  );
  assertEquals(repair.repairCheck, {
    name: "Lint",
    headRunId: idsOf(1).prRun,
  });
});

Deno.test("classifyBaseRedFailures - repairs a dependency audit that is red on the base, and defers the same fixture under a non-audit name", async () => {
  const audit = await classify({ specs: [redCheck("audit (Deno Audit)")] });
  assertStringIncludes(reasonOf(audit), "is a dependency audit");

  // Positive control: the identical fixture under a non-audit name defers.
  assertEquals(
    await classify({ specs: [redCheck("Deno Checks")] }),
    {
      kind: "defer",
      checks: [{ name: "Deno Checks", baseRunId: idsOf(0).baseRun }],
    },
  );
});

Deno.test("classifyBaseRedFailures - repairs when a commit status failed, and defers the same fixture with a passing status", async () => {
  const status = await classify({
    specs: [redCheck("Unit tests")],
    rollup: [{ state: "FAILURE" }],
  });
  assertStringIncludes(
    reasonOf(status),
    "a commit status failed, which has no base run to compare",
  );

  // Positive control: the identical fixture with a passing status defers.
  assertEquals(
    await classify({
      specs: [redCheck("Unit tests")],
      rollup: [{ state: "SUCCESS" }],
    }),
    {
      kind: "defer",
      checks: [{ name: "Unit tests", baseRunId: idsOf(0).baseRun }],
    },
  );
});

Deno.test("classifyBaseRedFailures - repairs when reading the head's check runs is rejected, with the error text", async () => {
  const decision = await classify({
    specs: [redCheck("Unit tests")],
    stub: { headError: "HTTP 503 from check-runs" },
  });
  assertStringIncludes(
    reasonOf(decision),
    "the head's check runs could not be read: HTTP 503 from check-runs",
  );
});

Deno.test("classifyBaseRedFailures - repairs when the head has more check runs than one page holds", async () => {
  const decision = await classify({
    specs: [redCheck("Unit tests")],
    stub: { total: 2 },
  });
  assertStringIncludes(
    reasonOf(decision),
    "the head has more check runs than one page holds",
  );
});

Deno.test("classifyBaseRedFailures - repairs when no failing check run is found", async () => {
  const decision = await classify({
    specs: [{ ...redCheck("Unit tests"), headConclusion: "success" }],
  });
  assertStringIncludes(reasonOf(decision), "no failing check run was found");
});

Deno.test("classifyBaseRedFailures - repairs when the failing check's log is an error, with its cause", async () => {
  const errored = (): Promise<ActionsLogOutcome> =>
    Promise.resolve({ kind: "error", error: "boom" });
  const decision = await classify({
    specs: [redCheck("Unit tests")],
    actionsLogFn: errored,
  });
  assertStringIncludes(
    reasonOf(decision),
    'the failing log of "Unit tests" was not readable: boom',
  );
});

Deno.test("classifyBaseRedFailures - repairs when the pull request has no base branch", async () => {
  const decision = await classifyBaseRedFailures({
    repo: REPO,
    headSha: HEAD_SHA,
    baseRef: "   ",
    rollup: [],
    ghFn: unusedGh,
  });
  assertEquals(decision, {
    kind: "repair",
    reason: "the pull request has no base",
  });
});

Deno.test("classifyBaseRedFailures - repairs when the head is not a full commit SHA", async () => {
  const decision = await classifyBaseRedFailures({
    repo: REPO,
    headSha: "not-a-sha",
    baseRef: BASE_REF,
    rollup: [],
    ghFn: unusedGh,
  });
  assertEquals(decision, {
    kind: "repair",
    reason: "the head is not a full SHA",
  });
});
