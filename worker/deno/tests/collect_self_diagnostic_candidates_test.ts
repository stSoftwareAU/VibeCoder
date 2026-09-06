/**
 * Tests for `collectSelfDiagnosticCandidates` (Issue #505).
 *
 * These are the issue's acceptance criteria, one test each: an auto-filed
 * worker diagnostic becomes claimable with no human label; a product-repo
 * issue, a human-filed issue and an unmarked issue do not; the in-flight cap
 * refuses the surplus and says so; the decision reaches the audit chain and
 * the issue; disabling the switch restores the previous behaviour exactly.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  collectSelfDiagnosticCandidates,
  SELF_DIAGNOSTIC_LABEL_INDEX,
  type SelfDiagnosticDeps,
} from "../lib/collect_self_diagnostic_candidates.ts";
import {
  formatSelfScheduleMarker,
  SELF_DIAGNOSTIC_REPO,
  SELF_SCHEDULE_AUDIT_VERB,
} from "../lib/self_diagnostic_provenance.ts";
import { formatIdleInversionBody } from "../lib/idle_inversion_streak.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createIssueFetcher } from "../lib/issue_finder_common.ts";
import type { FindIssuesOptions } from "../lib/issue_finder_common.ts";
import type { FilterableIssue } from "../lib/issue_filter.ts";
import type { ClosedPR, OpenPR } from "../lib/issue_query.ts";
import type { WorkerConfig } from "../types.ts";

const WORKER_LOGIN = "vibe-bot";
const PRODUCT_REPO = "stSoftwareAU/NEAT-AI-Rebase";

/** A recorded `gh` invocation, so tests can assert on side effects. */
interface GhCall {
  args: string[];
}

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    ...buildDefaultWorkerConfig(),
    repos: [SELF_DIAGNOSTIC_REPO],
    issueLabels: ["top-priority"],
    allowedAuthors: ["alice"],
    workOnLabel: "work-on",
    lowPriorityLabel: "low-priority",
    failedLabel: "failed",
    failedOnceLabel: "failed-once",
    refineIssueLabel: "refine-issue",
    planningLabel: "planning",
    questionLabel: "question",
    needsRevisionLabel: "needs-revision",
    needsHumanLabel: "needs-human",
    ...overrides,
  };
}

function diagnosticBody(subject = "stSoftwareAU/NEAT-AI-Rebase"): string {
  return formatIdleInversionBody({
    repo: subject,
    consecutiveCycles: 3,
    claimable: 26,
    detail: "census detail",
  });
}

function makeIssue(overrides: Partial<FilterableIssue> = {}): FilterableIssue {
  return {
    number: 39,
    title: "fix: idle-inversion on stSoftwareAU/NEAT-AI-Rebase",
    url: `https://github.com/${SELF_DIAGNOSTIC_REPO}/issues/39`,
    author: WORKER_LOGIN,
    assignees: [],
    labels: [],
    createdAt: "2026-08-26T00:00:00Z",
    milestone: "",
    body: diagnosticBody(),
    ...overrides,
  };
}

/** A `gh` runner that records calls and returns empty comment pages. */
function makeGh(calls: GhCall[], overrides: {
  comments?: string;
  failComment?: boolean;
} = {}): (args: string[]) => Promise<string> {
  return (args: string[]): Promise<string> => {
    calls.push({ args });
    const joined = args.join(" ");
    if (joined.includes("issue comment")) {
      if (overrides.failComment) {
        return Promise.reject(new Error("HTTP 403: comment refused"));
      }
      return Promise.resolve("");
    }
    if (joined.includes("comments")) {
      return Promise.resolve(overrides.comments ?? "[]");
    }
    return Promise.resolve("[]");
  };
}

function buildOptions(
  ghCommandFn: (args: string[]) => Promise<string>,
): FindIssuesOptions {
  return { githubUser: WORKER_LOGIN, ghCommandFn };
}

/** Deps capturing audit decisions instead of writing a real journal. */
function captureDeps(
  audited: string[],
  logs: string[],
  recordOk = true,
): SelfDiagnosticDeps {
  return {
    recordDecision: (entry) => {
      audited.push(
        `${SELF_SCHEDULE_AUDIT_VERB} ${entry.repo}#${entry.issueNumber} ` +
          `${entry.family.id}`,
      );
      return Promise.resolve(recordOk);
    },
    log: (message) => logs.push(message),
    dedupAuthors: FLEET_DEDUP,
  };
}

/** The fleet login the stubs write their own announcement comments as. */
const FLEET_LOGIN = "vibe-coder-bot";
/** Fleet identity the marker-author check is given instead of a config. */
const FLEET_DEDUP = { fleetAuthors: [FLEET_LOGIN] };

async function collect(opts: {
  repo?: string;
  config?: WorkerConfig;
  issues: FilterableIssue[];
  prs?: OpenPR[];
  closedPRs?: ClosedPR[];
  gh?: (args: string[]) => Promise<string>;
  deps?: SelfDiagnosticDeps;
}) {
  const calls: GhCall[] = [];
  const gh = opts.gh ?? makeGh(calls);
  return {
    calls,
    result: await collectSelfDiagnosticCandidates(
      opts.repo ?? SELF_DIAGNOSTIC_REPO,
      opts.config ?? makeConfig(),
      buildOptions(gh),
      opts.prs ?? [],
      opts.issues,
      createIssueFetcher(gh),
      opts.closedPRs ?? [],
      opts.deps ?? {},
    ),
  };
}

Deno.test("self-schedule - an auto-filed diagnostic is claimable with no label", async () => {
  const audited: string[] = [];
  const logs: string[] = [];
  const { result, calls } = await collect({
    issues: [makeIssue()],
    deps: captureDeps(audited, logs),
  });

  assertEquals(result.candidates.length, 1);
  const candidate = result.candidates[0]!;
  assertEquals(candidate.number, 39);
  assertEquals(candidate.source, "self-diagnostic");
  assertEquals(candidate.labelIndex, SELF_DIAGNOSTIC_LABEL_INDEX);
  assertEquals(result.refusals, []);

  // No label mutation of any kind was attempted.
  const labelCalls = calls.filter((c) =>
    c.args.join(" ").includes("--add-label")
  );
  assertEquals(labelCalls.length, 0);
});

Deno.test("self-schedule - the decision is audited and announced on the issue", async () => {
  const audited: string[] = [];
  const logs: string[] = [];
  const { result, calls } = await collect({
    issues: [makeIssue()],
    deps: captureDeps(audited, logs),
  });

  assertEquals(result.candidates.length, 1);
  assertEquals(audited, [
    `${SELF_SCHEDULE_AUDIT_VERB} ${SELF_DIAGNOSTIC_REPO}#39 idle-inversion`,
  ]);

  const comment = calls.find((c) => c.args.join(" ").includes("issue comment"));
  assert(comment !== undefined, "expected an announcement comment");
  const body = comment.args[comment.args.indexOf("--body") + 1]!;
  assertStringIncludes(body, formatSelfScheduleMarker("idle-inversion"));
  assertStringIncludes(body, "Self-scheduled");
});

Deno.test("self-schedule - the announcement is posted once, not once per scan", async () => {
  const calls: GhCall[] = [];
  const audited: string[] = [];
  const gh = makeGh(calls, {
    comments: JSON.stringify([
      {
        id: 1,
        body: formatSelfScheduleMarker("idle-inversion"),
        user: { login: FLEET_LOGIN },
      },
    ]),
  });
  const { result } = await collect({
    issues: [makeIssue()],
    gh,
    deps: captureDeps(audited, []),
  });

  assertEquals(result.candidates.length, 1);
  assertEquals(audited, [], "a re-scan must not re-audit the same decision");
  assertEquals(
    calls.filter((c) => c.args.join(" ").includes("issue comment")).length,
    0,
  );
});

Deno.test("self-schedule - an announcement marker planted by an outsider does not suppress the announcement (Issue #1216)", async () => {
  // The announcement is what makes a self-scheduled diagnostic traceable
  // before it is actionable. Matching the marker on the body alone let any
  // account erase that record by posting the marker itself.
  const calls: GhCall[] = [];
  const audited: string[] = [];
  const gh = makeGh(calls, {
    comments: JSON.stringify([
      {
        id: 1,
        body: formatSelfScheduleMarker("idle-inversion"),
        user: { login: "drive-by-attacker" },
      },
    ]),
  });
  const { result } = await collect({
    issues: [makeIssue()],
    gh,
    deps: captureDeps(audited, []),
  });

  assertEquals(result.candidates.length, 1);
  assertEquals(
    calls.filter((c) => c.args.join(" ").includes("issue comment")).length,
    1,
    "the worker posts its own announcement instead of trusting the planted one",
  );
});

Deno.test("self-schedule - a worker-filed issue in a product repo is not scheduled", async () => {
  const { result } = await collect({
    repo: PRODUCT_REPO,
    issues: [makeIssue()],
  });
  assertEquals(result.candidates, []);
});

Deno.test("self-schedule - an issue without a recognised marker is not scheduled", async () => {
  const { result } = await collect({
    issues: [makeIssue({ body: "Please fix the idle inversion." })],
  });
  assertEquals(result.candidates, []);
});

Deno.test("self-schedule - a human-filed issue carrying the marker is not scheduled", async () => {
  const { result } = await collect({
    issues: [makeIssue({ author: "alice" })],
  });
  assertEquals(result.candidates, []);
});

Deno.test("self-schedule - disabling the switch restores the previous behaviour", async () => {
  const calls: GhCall[] = [];
  const audited: string[] = [];
  const { result } = await collect({
    config: makeConfig({ selfScheduleDiagnosticsEnabled: false }),
    issues: [makeIssue()],
    gh: makeGh(calls),
    deps: captureDeps(audited, []),
  });
  assertEquals(result.candidates, []);
  assertEquals(result.refusals, []);
  assertEquals(audited, []);
  assertEquals(calls.length, 0);
});

Deno.test("self-schedule - the in-flight cap refuses the surplus and logs it", async () => {
  const audited: string[] = [];
  const logs: string[] = [];
  const { result } = await collect({
    issues: [
      makeIssue({ number: 39, assignees: [WORKER_LOGIN] }),
      makeIssue({
        number: 40,
        body: diagnosticBody("stSoftwareAU/other"),
        url: `https://github.com/${SELF_DIAGNOSTIC_REPO}/issues/40`,
      }),
    ],
    deps: captureDeps(audited, logs),
  });

  assertEquals(result.candidates, []);
  assertEquals(result.refusals.length, 1);
  assertEquals(result.refusals[0]!.issueNumber, 40);
  assertEquals(result.refusals[0]!.cause, "cap-reached");
  assert(
    logs.some((l) => l.includes("#40") && l.includes("refused")),
    `expected a refusal log line, got ${JSON.stringify(logs)}`,
  );
  assertEquals(audited, []);
});

Deno.test("self-schedule - a raised cap admits more than one diagnostic", async () => {
  const { result } = await collect({
    config: makeConfig({ selfScheduleDiagnosticsMaxInFlight: 2 }),
    issues: [
      makeIssue({ number: 39 }),
      makeIssue({
        number: 40,
        body: diagnosticBody("stSoftwareAU/other"),
        url: `https://github.com/${SELF_DIAGNOSTIC_REPO}/issues/40`,
      }),
    ],
    deps: captureDeps([], []),
  });
  assertEquals(result.candidates.map((c) => c.number), [39, 40]);
});

Deno.test("self-schedule - a cap of zero refuses everything", async () => {
  const logs: string[] = [];
  const { result } = await collect({
    config: makeConfig({ selfScheduleDiagnosticsMaxInFlight: 0 }),
    issues: [makeIssue()],
    deps: captureDeps([], logs),
  });
  assertEquals(result.candidates, []);
  assertEquals(result.refusals.length, 1);
  assert(logs.some((l) => l.includes("refused")));
});

Deno.test("self-schedule - an unrecordable decision is refused, not taken silently", async () => {
  const calls: GhCall[] = [];
  const logs: string[] = [];
  const { result } = await collect({
    issues: [makeIssue()],
    gh: makeGh(calls),
    deps: { ...captureDeps([], logs, false) },
  });

  assertEquals(result.candidates, []);
  assertEquals(result.refusals[0]!.cause, "audit-failed");
  assert(logs.some((l) => l.includes("audit chain")));
  assertEquals(
    calls.filter((c) => c.args.join(" ").includes("issue comment")).length,
    0,
    "nothing may be announced once the decision could not be recorded",
  );
});

Deno.test("self-schedule - a failed announcement refuses the schedule", async () => {
  const calls: GhCall[] = [];
  const logs: string[] = [];
  const { result } = await collect({
    issues: [makeIssue()],
    gh: makeGh(calls, { failComment: true }),
    deps: captureDeps([], logs),
  });

  assertEquals(result.candidates, []);
  assertEquals(result.refusals[0]!.cause, "announce-failed");
  assert(logs.some((l) => l.includes("announcement")));
});

Deno.test("self-schedule - a diagnostic a human already scheduled is left to its own tier", async () => {
  const { result } = await collect({
    issues: [makeIssue({ labels: ["work-on"] })],
  });
  assertEquals(result.candidates, []);
});

Deno.test("self-schedule - a needs-human diagnostic is not re-scheduled", async () => {
  const { result } = await collect({
    issues: [makeIssue({ labels: ["needs-human"] })],
  });
  assertEquals(result.candidates, []);
});

Deno.test("self-schedule - an open fleet PR defers the diagnostic", async () => {
  const { result } = await collect({
    issues: [makeIssue()],
    prs: [
      {
        number: 7,
        title: "fix: something",
        baseRefName: "main",
        headRefName: "issue-1",
        author: WORKER_LOGIN,
      } as OpenPR,
    ],
    config: makeConfig({ fleetPrAuthors: [WORKER_LOGIN] }),
  });
  assertEquals(result.candidates, []);
});

Deno.test("self-schedule - a merged PR blocks permanently and escalates to a human", async () => {
  const calls: GhCall[] = [];
  const gh = makeGh(calls);
  const { result } = await collect({
    issues: [makeIssue()],
    closedPRs: [
      {
        number: 12,
        title: "fix: idle-inversion (#39)",
        closedAt: "2026-08-27T00:00:00Z",
        merged: true,
        body: "Closes #39",
      } as ClosedPR,
    ],
    gh,
    deps: captureDeps([], []),
  });

  assertEquals(result.candidates, []);
  const joined = calls.map((c) => c.args.join(" "));
  assert(
    joined.some((c) =>
      c.includes("issues/39/labels") && c.includes("needs-human")
    ),
    `expected a needs-human escalation, got ${JSON.stringify(joined)}`,
  );
  assert(
    joined.some((c) =>
      c.includes("issues/39/comments") &&
      c.includes("cannot be self-scheduled")
    ),
    "escalation must come with an explanatory comment",
  );
});
