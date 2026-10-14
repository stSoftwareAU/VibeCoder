/**
 * Tests for the stable issue assignment (Issue #3718, part of #3644).
 *
 * The store is an in-memory fake, so the convergence and trust rules are
 * exercised against real assignment and ledger code with no GitHub access.
 * The `gh` adapter is tested with a fake `runGh`. Every ledger lives in a
 * temporary directory the test creates and removes.
 *
 * Australian English spelling used throughout.
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import type { AgentProviderDescriptor } from "../lib/agent_provider.ts";
import {
  type AssignmentEvent,
  LifecycleEventSchemaError,
  lifecycleLedgerPath,
  type LifecycleEvent,
  readLifecycleLedger,
  type RoleTreatment,
  UNASSIGNED_COHORT,
} from "../lib/lifecycle_ledger.ts";
import {
  ASSIGNMENT_MARKER_PREFIX,
  type AssignmentMarker,
  type AssignmentMarkerComment,
  type AssignmentMarkerStore,
  assignmentCommentBody,
  formatAssignmentMarker,
  ghAssignmentMarkerStore,
  type IssueAssignmentInput,
  type IssueAssignmentSeams,
  issueRunRoleTreatments,
  parseAssignmentMarker,
  recordIssueAssignment,
  selectTrustedAssignment,
} from "../lib/issue_assignment.ts";
import {
  buildIssueRunAgents,
  EXPLORER_AGENT_NAME,
  HAIKU_ISSUE_EXECUTOR_EFFORT,
  HAIKU_ISSUE_EXECUTOR_MODEL,
} from "../lib/issue_executor_agents.ts";

const REPO = "stSoftwareAU/VibeCoder";
const ISSUE = 3718;
const TRUSTED = ["VibeCoderST"];
const ASSIGNMENT_ID = "3f2c9a1e-4b5d-4c6e-8f70-1a2b3c4d5e6f";
const FORGED_ID = "0badc0de-0000-4000-8000-000000000001";
const FIXED_NOW = Date.parse("2026-10-14T10:00:00Z");
const ROLES: RoleTreatment[] = [
  { role: "manager", provider: "claude", model: "opus", effort: "high" },
];

/** Run `body` against a fresh temporary directory, removed afterwards. */
async function withTempDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "issue_assignment_test_" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Whether a file exists at `path`. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The assignment events in a ledger, narrowed to their type. */
function assignmentsOf(events: LifecycleEvent[]): AssignmentEvent[] {
  return events.filter((event): event is AssignmentEvent =>
    event.kind === "assignment"
  );
}

/**
 * An in-memory store. Posting appends a comment by `VibeCoderST`, with a
 * creation time one second after the last, so the earliest marker is the
 * first one posted.
 */
function fakeStore(initial: AssignmentMarkerComment[] = []): {
  store: AssignmentMarkerStore;
  posted: { repo: string; issueNumber: number; body: string }[];
} {
  const comments = [...initial];
  const posted: { repo: string; issueNumber: number; body: string }[] = [];
  let tick = FIXED_NOW;
  const store: AssignmentMarkerStore = {
    listMarkerComments: async () => comments.map((c) => ({ ...c })),
    postMarkerComment: async (repo, issueNumber, body) => {
      posted.push({ repo, issueNumber, body });
      tick += 1000;
      comments.push({
        author: "VibeCoderST",
        createdAt: new Date(tick).toISOString(),
        body,
      });
    },
  };
  return { store, posted };
}

/** A counter-backed mint, so every test can see how often an id was minted. */
function countingMint(): { mintId: () => string; calls: { count: number } } {
  const calls = { count: 0 };
  return {
    calls,
    mintId: () => {
      calls.count += 1;
      return `00000000-0000-4000-8000-${String(calls.count).padStart(12, "0")}`;
    },
  };
}

/** Seams for one run on one host, with fixed build facts unless given. */
function seamsFor(options: {
  store: AssignmentMarkerStore;
  ledgerPath: string;
  host: string;
  runId: string;
  mintId: () => string;
  buildFacts?: IssueAssignmentSeams["buildFacts"];
}): IssueAssignmentSeams {
  return {
    store: options.store,
    ledgerPath: options.ledgerPath,
    host: options.host,
    runId: options.runId,
    now: () => FIXED_NOW,
    mintId: options.mintId,
    buildFacts: options.buildFacts ??
      (() => ({ version: "v1.0.0", commit: "abc1234" })),
  };
}

/** The assignment input for this issue. */
function inputFor(
  overrides: Partial<IssueAssignmentInput> = {},
): IssueAssignmentInput {
  return {
    repo: REPO,
    issueNumber: ISSUE,
    trustedAuthors: TRUSTED,
    roles: ROLES,
    ...overrides,
  };
}

Deno.test("issue assignment - a restart and a second host reuse one assignment", async () => {
  await withTempDir(async (dir) => {
    const { store, posted } = fakeStore();
    const mint = countingMint();
    const hostA = lifecycleLedgerPath(dir, "host-a");
    const hostB = lifecycleLedgerPath(dir, "host-b");

    const first = await recordIssueAssignment(
      inputFor(),
      seamsFor({
        store,
        ledgerPath: hostA,
        host: "host-a",
        runId: "vibe-run-0001",
        mintId: mint.mintId,
      }),
    );
    // Restart: same host, a new run.
    const restart = await recordIssueAssignment(
      inputFor(),
      seamsFor({
        store,
        ledgerPath: hostA,
        host: "host-a",
        runId: "vibe-run-0002",
        mintId: mint.mintId,
      }),
    );
    // A second host, a new run.
    const second = await recordIssueAssignment(
      inputFor(),
      seamsFor({
        store,
        ledgerPath: hostB,
        host: "host-b",
        runId: "vibe-run-0003",
        mintId: mint.mintId,
      }),
    );

    assertEquals(first.reused, false);
    assertEquals(restart.reused, true);
    assertEquals(second.reused, true);
    assertEquals(restart.assignmentId, first.assignmentId);
    assertEquals(second.assignmentId, first.assignmentId);
    assertEquals(restart.cohort, first.cohort);
    assertEquals(second.cohort, first.cohort);
    assertEquals(first.cohort, UNASSIGNED_COHORT);
    assertEquals(mint.calls.count, 1);
    assertEquals(posted.length, 1);

    const hostEvents = assignmentsOf(await readLifecycleLedger(hostA));
    assertEquals(hostEvents.map((e) => e.host), ["host-a", "host-a"]);
    assertEquals(hostEvents.map((e) => e.runId), [
      "vibe-run-0001",
      "vibe-run-0002",
    ]);
    const otherEvents = assignmentsOf(await readLifecycleLedger(hostB));
    assertEquals(otherEvents.map((e) => e.host), ["host-b"]);
    assertEquals(otherEvents[0]?.reused, true);
  });
});

Deno.test("issue assignment - an existing trusted marker is reused without posting", async () => {
  await withTempDir(async (dir) => {
    const marker: AssignmentMarker = {
      assignmentId: ASSIGNMENT_ID,
      cohort: "exp-a",
      assignedAt: "2026-10-01T00:00:00Z",
    };
    const { store, posted } = fakeStore([{
      author: "VibeCoderST",
      createdAt: "2026-10-01T00:00:00Z",
      body: assignmentCommentBody(marker),
    }]);
    const mint = countingMint();

    const record = await recordIssueAssignment(
      inputFor(),
      seamsFor({
        store,
        ledgerPath: `${dir}/ledger.jsonl`,
        host: "host-a",
        runId: "vibe-run-0001",
        mintId: mint.mintId,
      }),
    );

    assertEquals(record, {
      assignmentId: ASSIGNMENT_ID,
      cohort: "exp-a",
      reused: true,
    });
    assertEquals(posted.length, 0);
    assertEquals(mint.calls.count, 0);
  });
});

Deno.test("issue assignment - a forged marker from an untrusted author is ignored", async () => {
  await withTempDir(async (dir) => {
    const { store, posted } = fakeStore([{
      author: "mallory",
      createdAt: "2026-10-01T00:00:00Z",
      body: formatAssignmentMarker({
        assignmentId: FORGED_ID,
        cohort: "exp-a",
        assignedAt: "2026-10-01T00:00:00Z",
      }),
    }]);
    const mint = countingMint();

    const record = await recordIssueAssignment(
      inputFor(),
      seamsFor({
        store,
        ledgerPath: `${dir}/ledger.jsonl`,
        host: "host-a",
        runId: "vibe-run-0001",
        mintId: mint.mintId,
      }),
    );

    assertEquals(record.reused, false);
    assertEquals(record.cohort, UNASSIGNED_COHORT);
    assert(record.assignmentId !== FORGED_ID);
    assertEquals(mint.calls.count, 1);
    assertEquals(posted.length, 1);
  });
});

Deno.test("issue assignment - the earliest of two trusted markers wins", () => {
  const early: AssignmentMarkerComment = {
    author: "VibeCoderST",
    createdAt: "2026-10-01T00:00:00Z",
    body: formatAssignmentMarker({
      assignmentId: ASSIGNMENT_ID,
      cohort: "exp-a",
      assignedAt: "2026-10-01T00:00:00Z",
    }),
  };
  const late: AssignmentMarkerComment = {
    author: "VibeCoderST",
    createdAt: "2026-10-05T00:00:00Z",
    body: formatAssignmentMarker({
      assignmentId: FORGED_ID,
      cohort: "exp-b",
      assignedAt: "2026-10-05T00:00:00Z",
    }),
  };
  // The later comment is listed first; ordering must come from createdAt.
  const winner = selectTrustedAssignment([late, early], TRUSTED);
  assertEquals(winner?.assignmentId, ASSIGNMENT_ID);
  assertEquals(winner?.cohort, "exp-a");
});

Deno.test("issue assignment - earliest is by time, not by string order", () => {
  // Lexically "…00.100Z" sorts before "…00Z", but 00.000 is the earlier time.
  const withMillis: AssignmentMarkerComment = {
    author: "VibeCoderST",
    createdAt: "2026-10-01T00:00:00.100Z",
    body: formatAssignmentMarker({
      assignmentId: FORGED_ID,
      cohort: "exp-b",
      assignedAt: "2026-10-01T00:00:00.100Z",
    }),
  };
  const whole: AssignmentMarkerComment = {
    author: "VibeCoderST",
    createdAt: "2026-10-01T00:00:00Z",
    body: formatAssignmentMarker({
      assignmentId: ASSIGNMENT_ID,
      cohort: "exp-a",
      assignedAt: "2026-10-01T00:00:00Z",
    }),
  };
  assertEquals(
    selectTrustedAssignment([withMillis, whole], TRUSTED)?.assignmentId,
    ASSIGNMENT_ID,
  );
});

Deno.test("issue assignment - an empty trusted set trusts nothing", () => {
  const comment: AssignmentMarkerComment = {
    author: "VibeCoderST",
    createdAt: "2026-10-01T00:00:00Z",
    body: formatAssignmentMarker({
      assignmentId: ASSIGNMENT_ID,
      cohort: "exp-a",
      assignedAt: "2026-10-01T00:00:00Z",
    }),
  };
  assertEquals(selectTrustedAssignment([comment], []), undefined);
});

Deno.test("issue assignment - a failing list rejects and writes nothing", async () => {
  await withTempDir(async (dir) => {
    const ledger = `${dir}/ledger.jsonl`;
    let posts = 0;
    const store: AssignmentMarkerStore = {
      listMarkerComments: () => Promise.reject(new Error("gh api exploded")),
      postMarkerComment: async () => {
        posts += 1;
      },
    };
    await assertRejects(
      () =>
        recordIssueAssignment(
          inputFor(),
          seamsFor({
            store,
            ledgerPath: ledger,
            host: "host-a",
            runId: "vibe-run-0001",
            mintId: countingMint().mintId,
          }),
        ),
      Error,
      "gh api exploded",
    );
    assertEquals(posts, 0);
    assertEquals(await exists(ledger), false);
  });
});

Deno.test("issue assignment - a failing post rejects and writes nothing", async () => {
  await withTempDir(async (dir) => {
    const ledger = `${dir}/ledger.jsonl`;
    const store: AssignmentMarkerStore = {
      listMarkerComments: async () => [],
      postMarkerComment: () =>
        Promise.reject(new Error("gh issue comment failed")),
    };
    await assertRejects(
      () =>
        recordIssueAssignment(
          inputFor(),
          seamsFor({
            store,
            ledgerPath: ledger,
            host: "host-a",
            runId: "vibe-run-0001",
            mintId: countingMint().mintId,
          }),
        ),
      Error,
      "gh issue comment failed",
    );
    assertEquals(await exists(ledger), false);
  });
});

Deno.test("issue assignment - an invalid subscription allocation is refused before posting", async () => {
  await withTempDir(async (dir) => {
    const ledger = `${dir}/ledger.jsonl`;
    const { store, posted } = fakeStore();
    await assertRejects(
      () =>
        recordIssueAssignment(
          inputFor({ subscriptionAllocation: "ops@example.com" }),
          seamsFor({
            store,
            ledgerPath: ledger,
            host: "host-a",
            runId: "vibe-run-0001",
            mintId: countingMint().mintId,
          }),
        ),
      LifecycleEventSchemaError,
    );
    assertEquals(posted.length, 0);
    assertEquals(await exists(ledger), false);
  });
});

Deno.test("issue assignment - the treatment records build facts when present", async () => {
  await withTempDir(async (dir) => {
    const ledger = `${dir}/ledger.jsonl`;
    const { store } = fakeStore();
    await recordIssueAssignment(
      inputFor({ subscriptionAllocation: "acct-1" }),
      seamsFor({
        store,
        ledgerPath: ledger,
        host: "host-a",
        runId: "vibe-run-0001",
        mintId: countingMint().mintId,
        buildFacts: () => ({ version: "v1.0.0", commit: "abc1234" }),
      }),
    );
    const [event] = assignmentsOf(await readLifecycleLedger(ledger));
    assertEquals(event?.treatment.workerVersion, "v1.0.0");
    assertEquals(event?.treatment.workerCommit, "abc1234");
    assertEquals(event?.treatment.subscriptionAllocation, "acct-1");
    assertEquals(event?.treatment.roles, ROLES);
  });
});

Deno.test("issue assignment - the treatment omits build facts when absent", async () => {
  await withTempDir(async (dir) => {
    const ledger = `${dir}/ledger.jsonl`;
    const { store } = fakeStore();
    await recordIssueAssignment(
      inputFor(),
      seamsFor({
        store,
        ledgerPath: ledger,
        host: "host-a",
        runId: "vibe-run-0001",
        mintId: countingMint().mintId,
        buildFacts: () => ({}),
      }),
    );
    const [event] = assignmentsOf(await readLifecycleLedger(ledger));
    assert(event !== undefined);
    assertEquals("workerVersion" in event.treatment, false);
    assertEquals("workerCommit" in event.treatment, false);
    assertEquals("subscriptionAllocation" in event.treatment, false);
  });
});

Deno.test("issue assignment - a marker round trips through format and parse", () => {
  const whole: AssignmentMarker = {
    assignmentId: ASSIGNMENT_ID,
    cohort: "exp-a",
    assignedAt: "2026-10-14T10:00:00Z",
  };
  assertEquals(parseAssignmentMarker(formatAssignmentMarker(whole)), whole);

  const millis: AssignmentMarker = {
    ...whole,
    assignedAt: "2026-10-14T10:00:00.123Z",
  };
  assertEquals(parseAssignmentMarker(formatAssignmentMarker(millis)), millis);
});

Deno.test("issue assignment - malformed markers parse to undefined", () => {
  const good = {
    assignmentId: ASSIGNMENT_ID,
    cohort: "exp-a",
    assignedAt: "2026-10-14T10:00:00Z",
  };
  assertEquals(parseAssignmentMarker(""), undefined);
  assertEquals(
    parseAssignmentMarker("no marker here"),
    undefined,
  );
  // An upper-case id is not the lowercase form the ledger accepts.
  assertEquals(
    parseAssignmentMarker(
      formatAssignmentMarker({
        ...good,
        assignmentId: ASSIGNMENT_ID.toUpperCase(),
      }),
    ),
    undefined,
  );
  // A cohort with a space or an e-mail address is not a label.
  assertEquals(
    parseAssignmentMarker(formatAssignmentMarker({ ...good, cohort: "Exp A" })),
    undefined,
  );
  assertEquals(
    parseAssignmentMarker(
      formatAssignmentMarker({ ...good, cohort: "alice@example.com" }),
    ),
    undefined,
  );
  // A timestamp with the right shape but an impossible date.
  assertEquals(
    parseAssignmentMarker(
      formatAssignmentMarker({ ...good, assignedAt: "2026-13-45T10:00:00Z" }),
    ),
    undefined,
  );
});

Deno.test("issue assignment - a hostile long marker parses to undefined", () => {
  const hostile = ASSIGNMENT_MARKER_PREFIX + " " + "a".repeat(100_000);
  assertEquals(parseAssignmentMarker(hostile), undefined);
});

Deno.test("issue assignment - the gh store parses the observed compact JSON lines", async () => {
  const body = assignmentCommentBody({
    assignmentId: ASSIGNMENT_ID,
    cohort: "exp-a",
    assignedAt: "2026-10-14T10:00:00Z",
  });
  // The shape gh prints: one compact object per line, with < and > escaped.
  const sample =
    '{"author":"VibeCoderST","body":"\\u003c!-- vibe-assignment: id=' +
    ASSIGNMENT_ID + " cohort=exp-a assigned=2026-10-14T10:00:00Z --\\u003e" +
    '\\n\\n","created_at":"2026-10-14T10:53:42Z"}';
  const calls: string[][] = [];
  const store = ghAssignmentMarkerStore((args) => {
    calls.push(args);
    return Promise.resolve(sample + "\n\n");
  });

  const comments = await store.listMarkerComments(REPO, ISSUE);

  assertEquals(comments.length, 1);
  assertEquals(comments[0]?.author, "VibeCoderST");
  assertEquals(comments[0]?.createdAt, "2026-10-14T10:53:42Z");
  assertStringIncludes(comments[0]?.body ?? "", ASSIGNMENT_MARKER_PREFIX);
  assertEquals(parseAssignmentMarker(comments[0]?.body ?? "")?.cohort, "exp-a");
  assert(body.includes(ASSIGNMENT_MARKER_PREFIX));

  const [args] = calls;
  assertEquals(args?.[0], "api");
  assert(args?.includes("--paginate"));
  assert(args?.includes(`repos/${REPO}/issues/${ISSUE}/comments`));
});

Deno.test("issue assignment - the gh store names the issue on an unreadable line", async () => {
  const store = ghAssignmentMarkerStore(() =>
    Promise.resolve("this is not json\n")
  );
  await assertRejects(
    () => store.listMarkerComments(REPO, ISSUE),
    Error,
    `${REPO}#${ISSUE}`,
  );
});

Deno.test("issue assignment - the gh store posts with the issue comment arguments", async () => {
  const calls: string[][] = [];
  const store = ghAssignmentMarkerStore((args) => {
    calls.push(args);
    return Promise.resolve("");
  });
  await store.postMarkerComment(REPO, ISSUE, "body text");
  assertEquals(calls, [[
    "issue",
    "comment",
    String(ISSUE),
    "--repo",
    REPO,
    "--body",
    "body text",
  ]]);
});

/** A descriptor with the two routing methods the manager's routing reads. */
function fakeProvider(
  id: string,
  model: string | undefined,
  effort: string | undefined,
): AgentProviderDescriptor {
  return {
    id,
    resolveModel: () => model,
    resolveEffort: () => effort,
  } as unknown as AgentProviderDescriptor;
}

Deno.test("issue assignment - the Claude run lists the manager, executor and reviewers", () => {
  const agents = buildIssueRunAgents({
    executorSplit: true,
    reviewerAgents: true,
    subAgentTier: "haiku",
  });
  assert(agents !== undefined);
  const roles = issueRunRoleTreatments({
    provider: fakeProvider("claude", "opus", "high"),
    agents,
  });

  assertEquals(roles[0], {
    role: "manager",
    provider: "claude",
    model: "opus",
    effort: "high",
  });
  assertEquals(
    roles.find((r) => r.agent === "executor"),
    {
      role: "executor",
      agent: "executor",
      provider: "claude",
      model: HAIKU_ISSUE_EXECUTOR_MODEL,
      effort: HAIKU_ISSUE_EXECUTOR_EFFORT,
    },
  );
  const reviewers = roles.filter((r) => r.role === "reviewer");
  assertEquals(reviewers.map((r) => r.agent).sort(), [
    "spec-reviewer",
    "standards-reviewer",
  ]);
  assertEquals(roles.length, 4);
  // The read-only explorer is not one of the three roles.
  assertEquals(roles.some((r) => r.agent === EXPLORER_AGENT_NAME), false);
});

Deno.test("issue assignment - an explicit Claude model overrides the manager", () => {
  const roles = issueRunRoleTreatments({
    provider: fakeProvider("claude", "opus", "high"),
    claudeModel: "sonnet",
  });
  assertEquals(roles, [{
    role: "manager",
    provider: "claude",
    model: "sonnet",
    effort: "high",
  }]);
});

Deno.test("issue assignment - a non-Claude provider lists the manager only", () => {
  const agents = buildIssueRunAgents({
    executorSplit: true,
    reviewerAgents: true,
    subAgentTier: "sonnet",
  });
  const roles = issueRunRoleTreatments({
    provider: fakeProvider("codex", undefined, undefined),
    agents,
  });
  assertEquals(roles, [{ role: "manager", provider: "codex" }]);
});
