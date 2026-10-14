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
  buildIssueCommentsPageArgs,
  COMMENTS_PER_PAGE,
} from "../lib/issue_comment_pages.ts";
import {
  type AssignmentEvent,
  type LifecycleEvent,
  LifecycleEventSchemaError,
  lifecycleLedgerPath,
  readLifecycleLedger,
  type RoleTreatment,
  UNASSIGNED_COHORT,
} from "../lib/lifecycle_ledger.ts";
import {
  ASSIGNMENT_MARKER_PREFIX,
  assignmentCommentBody,
  type AssignmentMarker,
  type AssignmentMarkerComment,
  type AssignmentMarkerStore,
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

/** One REST comment, as `repos/…/issues/…/comments` returns it. */
function restComment(
  login: string | undefined,
  createdAt: string | undefined,
  body: string,
): Record<string, unknown> {
  const comment: Record<string, unknown> = { body };
  if (login !== undefined) comment.user = { login };
  if (createdAt !== undefined) comment.created_at = createdAt;
  return comment;
}

/**
 * A fake `gh` that answers each bounded page request with the matching entry
 * of `pages`. A page beyond the list is an empty array.
 */
function fakePagedGh(pages: string[]): {
  runGh: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runGh = (args: string[]): Promise<string> => {
    calls.push(args);
    for (let page = 1; page <= pages.length; page++) {
      const expected = buildIssueCommentsPageArgs(REPO, ISSUE, page);
      if (JSON.stringify(args) === JSON.stringify(expected)) {
        return Promise.resolve(pages[page - 1] ?? "[]");
      }
    }
    return Promise.resolve("[]");
  };
  return { runGh, calls };
}

Deno.test("issue assignment - the gh store reads page 1 and keeps only marker comments", async () => {
  const page = JSON.stringify([
    // The REST shape, with < and > as plain characters in the JSON body.
    restComment(
      "VibeCoderST",
      "2026-10-14T10:53:42Z",
      `<!-- vibe-assignment: id=${ASSIGNMENT_ID} cohort=exp-a assigned=2026-10-14T10:00:00Z -->\n\nLifecycle assignment.`,
    ),
    restComment("someone", "2026-10-14T10:54:00Z", "A plain comment."),
    restComment(
      "mallory",
      "2026-10-14T10:55:00Z",
      `<!-- vibe-assignment: id=${FORGED_ID} cohort=exp-b assigned=2026-10-14T10:00:00Z -->`,
    ),
  ]);
  const fake = fakePagedGh([page]);
  const store = ghAssignmentMarkerStore(fake.runGh);

  const comments = await store.listMarkerComments(REPO, ISSUE);

  assertEquals(comments.map((c) => c.author), ["VibeCoderST", "mallory"]);
  assertEquals(comments.map((c) => c.createdAt), [
    "2026-10-14T10:53:42Z",
    "2026-10-14T10:55:00Z",
  ]);
  assertStringIncludes(comments[0]?.body ?? "", ASSIGNMENT_MARKER_PREFIX);
  assertEquals(parseAssignmentMarker(comments[0]?.body ?? "")?.cohort, "exp-a");
  // A short first page ends pagination, so exactly one request is made.
  assertEquals(fake.calls.length, 1);
  assertEquals(fake.calls[0], buildIssueCommentsPageArgs(REPO, ISSUE, 1));
});

Deno.test("issue assignment - the gh store skips marker comments it cannot attribute", async () => {
  const marker =
    `<!-- vibe-assignment: id=${ASSIGNMENT_ID} cohort=exp-a assigned=2026-10-14T10:00:00Z -->`;
  const page = JSON.stringify([
    restComment(undefined, "2026-10-14T10:53:42Z", marker),
    restComment("VibeCoderST", undefined, marker),
    restComment("VibeCoderST", "2026-10-14T10:53:42Z", marker),
  ]);
  const store = ghAssignmentMarkerStore(fakePagedGh([page]).runGh);

  const comments = await store.listMarkerComments(REPO, ISSUE);

  assertEquals(comments.length, 1);
  assertEquals(comments[0]?.author, "VibeCoderST");
});

Deno.test("issue assignment - the gh store follows a full page to the next", async () => {
  const filler = Array.from(
    { length: COMMENTS_PER_PAGE },
    () => restComment("someone", "2026-10-14T10:00:00Z", "A plain comment."),
  );
  const marker = restComment(
    "VibeCoderST",
    "2026-10-14T10:53:42Z",
    `<!-- vibe-assignment: id=${ASSIGNMENT_ID} cohort=exp-a assigned=2026-10-14T10:00:00Z -->`,
  );
  const fake = fakePagedGh([
    JSON.stringify(filler),
    JSON.stringify([marker]),
  ]);
  const store = ghAssignmentMarkerStore(fake.runGh);

  const comments = await store.listMarkerComments(REPO, ISSUE);

  assertEquals(comments.map((c) => c.author), ["VibeCoderST"]);
  assertEquals(fake.calls.length, 2);
  assertEquals(fake.calls[1], buildIssueCommentsPageArgs(REPO, ISSUE, 2));
});

Deno.test("issue assignment - the gh store rejects a non-array page, naming the issue", async () => {
  const store = ghAssignmentMarkerStore(
    fakePagedGh([
      '{"message":"Not Found"}',
    ]).runGh,
  );
  await assertRejects(
    () => store.listMarkerComments(REPO, ISSUE),
    Error,
    `${REPO}#${ISSUE}`,
  );
});

Deno.test("issue assignment - the gh store propagates a failing gh call", async () => {
  const store = ghAssignmentMarkerStore(() =>
    Promise.reject(new Error("gh api exploded"))
  );
  await assertRejects(
    () => store.listMarkerComments(REPO, ISSUE),
    Error,
    "gh api exploded",
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

Deno.test("issue assignment - an unparseable createdAt sorts after a parseable one", () => {
  const unparseable: AssignmentMarkerComment = {
    author: "VibeCoderST",
    createdAt: "not-a-time",
    body: formatAssignmentMarker({
      assignmentId: FORGED_ID,
      cohort: "exp-b",
      assignedAt: "2026-10-01T00:00:00Z",
    }),
  };
  const parseable: AssignmentMarkerComment = {
    author: "VibeCoderST",
    createdAt: "2026-10-05T00:00:00Z",
    body: formatAssignmentMarker({
      assignmentId: ASSIGNMENT_ID,
      cohort: "exp-a",
      assignedAt: "2026-10-05T00:00:00Z",
    }),
  };
  assertEquals(
    selectTrustedAssignment([unparseable, parseable], TRUSTED)?.assignmentId,
    ASSIGNMENT_ID,
  );
  assertEquals(
    selectTrustedAssignment([parseable, unparseable], TRUSTED)?.assignmentId,
    ASSIGNMENT_ID,
  );
});

Deno.test("issue assignment - a whitespace-only subscription allocation records no label", async () => {
  await withTempDir(async (dir) => {
    const ledger = `${dir}/ledger.jsonl`;
    const { store } = fakeStore();
    await recordIssueAssignment(
      inputFor({ subscriptionAllocation: "   " }),
      seamsFor({
        store,
        ledgerPath: ledger,
        host: "host-a",
        runId: "vibe-run-0001",
        mintId: countingMint().mintId,
      }),
    );
    const [event] = assignmentsOf(await readLifecycleLedger(ledger));
    assert(event !== undefined);
    assertEquals("subscriptionAllocation" in event.treatment, false);
  });
});

Deno.test("issue assignment - the gh store skips page items that are not objects or lack a string body", async () => {
  const marker =
    `<!-- vibe-assignment: id=${ASSIGNMENT_ID} cohort=exp-a assigned=2026-10-14T10:00:00Z -->`;
  const page = JSON.stringify([
    42,
    null,
    {
      user: { login: "VibeCoderST" },
      created_at: "2026-10-14T10:53:42Z",
      body: 7,
    },
    restComment("VibeCoderST", "2026-10-14T10:53:42Z", marker),
  ]);
  const store = ghAssignmentMarkerStore(fakePagedGh([page]).runGh);

  const comments = await store.listMarkerComments(REPO, ISSUE);

  assertEquals(comments, [{
    author: "VibeCoderST",
    createdAt: "2026-10-14T10:53:42Z",
    body: marker,
  }]);
});

Deno.test("issue assignment - a sub-agent with blank model and effort omits them", () => {
  const roles = issueRunRoleTreatments({
    provider: fakeProvider("claude", "opus", "high"),
    agents: {
      executor: { description: "d", prompt: "p", model: "  ", effort: "" },
    },
  });
  assertEquals(roles, [
    { role: "manager", provider: "claude", model: "opus", effort: "high" },
    { role: "executor", agent: "executor", provider: "claude" },
  ]);
});

/**
 * A store where another host's earlier trusted marker lands in the same
 * window as ours: the post inserts our comment, then the rival's.
 */
function racingStore(rival: AssignmentMarkerComment): {
  store: AssignmentMarkerStore;
  posted: string[];
} {
  const comments: AssignmentMarkerComment[] = [];
  const posted: string[] = [];
  const store: AssignmentMarkerStore = {
    listMarkerComments: async () => comments.map((c) => ({ ...c })),
    postMarkerComment: async (_repo, _issueNumber, body) => {
      posted.push(body);
      comments.push({
        author: "VibeCoderST",
        createdAt: "2026-10-14T10:00:01Z",
        body,
      });
      comments.push({ ...rival });
    },
  };
  return { store, posted };
}

Deno.test("issue assignment - a racing earlier trusted marker is adopted after the re-read", async () => {
  await withTempDir(async (dir) => {
    const ledger = `${dir}/ledger.jsonl`;
    const rivalId = "11111111-2222-4333-8444-555555555555";
    const rival: AssignmentMarkerComment = {
      author: "VibeCoderST",
      createdAt: "2026-10-14T09:59:00Z",
      body: formatAssignmentMarker({
        assignmentId: rivalId,
        cohort: "exp-a",
        assignedAt: "2026-10-01T00:00:00Z",
      }),
    };
    const { store, posted } = racingStore(rival);
    const mint = countingMint();

    const record = await recordIssueAssignment(
      inputFor(),
      seamsFor({
        store,
        ledgerPath: ledger,
        host: "host-a",
        runId: "vibe-run-0001",
        mintId: mint.mintId,
      }),
    );

    assertEquals(record, {
      assignmentId: rivalId,
      cohort: "exp-a",
      reused: true,
    });
    assertEquals(mint.calls.count, 1);
    assertEquals(posted.length, 1);
    const [event] = assignmentsOf(await readLifecycleLedger(ledger));
    assertEquals(event?.assignmentId, rivalId);
    assertEquals(event?.cohort, "exp-a");
    assertEquals(event?.assignedAt, "2026-10-01T00:00:00Z");
    assertEquals(event?.reused, true);
  });
});

Deno.test("issue assignment - a failing re-read after posting rejects and appends nothing", async () => {
  await withTempDir(async (dir) => {
    const ledger = `${dir}/ledger.jsonl`;
    const { store, posted } = fakeStore();
    let reads = 0;
    const flaky: AssignmentMarkerStore = {
      listMarkerComments: (repo, issueNumber) => {
        reads += 1;
        if (reads > 1) {
          return Promise.reject(new Error("gh re-read exploded"));
        }
        return store.listMarkerComments(repo, issueNumber);
      },
      postMarkerComment: store.postMarkerComment,
    };
    await assertRejects(
      () =>
        recordIssueAssignment(
          inputFor(),
          seamsFor({
            store: flaky,
            ledgerPath: ledger,
            host: "host-a",
            runId: "vibe-run-0001",
            mintId: countingMint().mintId,
          }),
        ),
      Error,
      "gh re-read exploded",
    );
    assertEquals(posted.length, 1);
    assertEquals(await exists(ledger), false);
  });
});
