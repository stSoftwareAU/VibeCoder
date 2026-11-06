/**
 * Review dismissal waits for the independent verifier (Issue #4657). These
 * tests drive the real `finishBabysitterRepair` with injected git, GitHub and
 * verifier fakes, and check which reviews reach the dismiss function.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { finishBabysitterRepair } from "../commands/fleet_pr_babysitter.ts";
import type {
  ReviewVerificationInput,
  ReviewVerificationOutcome,
} from "../lib/babysitter_review_verifier.ts";

type Reviews = Parameters<typeof finishBabysitterRepair>[4];
type ReviewItem = Reviews[number];
type Verifier = (
  input: ReviewVerificationInput,
) => Promise<ReviewVerificationOutcome[]>;

const REPO = "stSoftwareAU/NEAT-AI-Discovery";
const OLD_HEAD = "1".repeat(40);
const PUSHED_HEAD = "2".repeat(40);
const OTHER_HEAD = "3".repeat(40);
const PART_OF_BODY =
  "## Summary\n\nPart of stSoftwareAU/NEAT-AI-Discovery#2422.\n";
const CLOSES_PROPOSAL =
  "## Summary\n\nCloses stSoftwareAU/NEAT-AI-Discovery#2422.\n";
/** PR #4611's requested review, as GitHub returns it (Issue #4657). */
const REVIEW_4611_ID = 5727298859;
const REVIEW_4611_BODY =
  "**`docs/archive/pr-summaries/pr-summary-2422.md:3`**: The summary writes `Part of stSoftwareAU/NEAT-AI-Discovery#2422` with no Acceptance Criteria block marking anything missing. Fix: write Closes.";

const pr = {
  state: "OPEN",
  number: 4611,
  title: "Write the PR summary",
  author: { login: "fleet" },
  headRefName: "review-fix-branch",
  headRefOid: OLD_HEAD,
  baseRefName: "main",
  isCrossRepository: false,
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  // A repair addresses requested changes, so the PR still has a blocker.
  reviewDecision: "CHANGES_REQUESTED",
  statusCheckRollup: [{ conclusion: "SUCCESS" }],
};

function review(id: number, body = `finding ${id}`): ReviewItem {
  return { id, state: "CHANGES_REQUESTED", user: { login: "reviewer" }, body };
}

const verifiedAll: Verifier = (input) =>
  Promise.resolve(
    input.reviews.map((item) => ({
      id: item.id,
      verified: true,
      reason: "fixed",
    })),
  );

const verifiedNone: Verifier = (input) =>
  Promise.resolve(
    input.reviews.map((item) => ({
      id: item.id,
      verified: false,
      reason: "not fixed",
    })),
  );

/** A GitHub stand-in for the repair's PR reads and its description edit. */
function fakeGitHub(options: {
  headRefOid: string;
  body: string;
  failEdit?: boolean;
  /** The head GitHub reports from the nth `pr view` on, counting from 1. */
  moveHeadAtView?: { view: number; head: string };
}) {
  let body = options.body;
  let headRefOid = options.headRefOid;
  let views = 0;
  const gh = async (args: string[]): Promise<string> => {
    if (args[0] === "pr" && args[1] === "view") {
      views++;
      if (views === options.moveHeadAtView?.view) {
        headRefOid = options.moveHeadAtView.head;
      }
      return JSON.stringify({
        headRefOid,
        body,
        closingIssuesReferences: [],
      });
    }
    if (args[0] === "pr" && args[1] === "edit") {
      if (options.failEdit) {
        throw new Error("simulated body publication failure");
      }
      const bodyFile = args[args.indexOf("--body-file") + 1];
      if (!bodyFile) throw new Error("missing --body-file");
      body = await Deno.readTextFile(bodyFile);
      return "";
    }
    throw new Error(`unexpected gh command: ${args.join(" ")}`);
  };
  return {
    gh,
    body: () => body,
    setBody: (next: string) => {
      body = next;
    },
    setHead: (head: string) => {
      headRefOid = head;
    },
  };
}

/** Git and API answers for a repair; a changed tree pushes `PUSHED_HEAD`. */
function fakeRunCommand(options: { changed: boolean; events: string[] }) {
  return (command: string, args: string[]): Promise<string> => {
    if (command === "git" && args[0] === "status") {
      return Promise.resolve(options.changed ? " M summary" : "");
    }
    if (command === "git" && args[0] === "diff") return Promise.resolve("");
    if (command === "gh" && args[0] === "api") return Promise.resolve("12345");
    if (command === "git" && args[0] === "push") {
      options.events.push("push");
      return Promise.resolve("");
    }
    if (command === "git" && args[0] === "rev-parse") {
      return Promise.resolve(PUSHED_HEAD);
    }
    return Promise.reject(
      new Error(`unexpected command: ${command} ${args.join(" ")}`),
    );
  };
}

/** A body sync that finds the body current, so only the repair's own publication runs. */
const skipSync = () =>
  Promise.resolve({
    ok: true as const,
    value: { status: "skipped" as const, reason: "body already current" },
  });

interface FinishOptions {
  changed: boolean;
  reviews: Reviews;
  github: ReturnType<typeof fakeGitHub>;
  verifyReviews: Verifier;
  proposal?: string;
  agentReply?: string;
}

interface FinishRecord {
  /** The review id lists each dismiss call received. */
  dismissed: number[][];
  /** Every input the verifier was called with. */
  inputs: ReviewVerificationInput[];
  events: string[];
}

async function runFinish(options: FinishOptions): Promise<FinishRecord> {
  const events: string[] = [];
  const dismissed: number[][] = [];
  const inputs: ReviewVerificationInput[] = [];
  const exchange = await Deno.makeTempDir({
    prefix: "babysitter-review-4657-",
  });
  try {
    await finishBabysitterRepair(
      REPO,
      pr,
      "/unused-repo",
      "babysitter[bot]",
      options.reviews,
      {
        renewalFailed: () => false,
        runCommand: fakeRunCommand({ changed: options.changed, events }),
        readPr: () => Promise.resolve({ ...pr }),
        validateAndCommit: () => Promise.resolve(),
        gh: options.github.gh,
        syncBodyFn: skipSync,
        headWaitDelayMs: 0,
        dismiss: (reviews) => {
          dismissed.push(reviews.map((item) => item.id));
          return Promise.resolve();
        },
        verifyReviews: (input) => {
          inputs.push(input);
          return options.verifyReviews(input);
        },
      },
      {
        exchange,
        proposal: options.proposal,
        agentReply: options.agentReply,
      },
    );
  } finally {
    await Deno.remove(exchange, { recursive: true });
  }
  return { dismissed, inputs, events };
}

/** The one verifier input a run made; the run must have called the verifier once. */
function onlyInput(record: FinishRecord): ReviewVerificationInput {
  assertEquals(record.inputs.length, 1);
  const [input] = record.inputs;
  assert(input !== undefined, "the verifier was not called");
  return input;
}

/** Collects the console lines a run writes, so the stays-open log can be checked. */
async function captureLogs<T>(
  run: () => Promise<T>,
): Promise<{ value: T; logs: string[] }> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    return { value: await run(), logs };
  } finally {
    console.log = original;
  }
}

Deno.test("a complete fix dismisses every review the verifier judged fixed (Issue #4657)", async () => {
  const github = fakeGitHub({ headRefOid: PUSHED_HEAD, body: PART_OF_BODY });
  const record = await runFinish({
    changed: true,
    reviews: [review(1), review(2)],
    github,
    verifyReviews: verifiedAll,
    agentReply: "Fixed both findings.\nBABYSITTER_READY",
  });
  assertEquals(record.dismissed, [[1, 2]]);
  assertEquals(record.inputs.length, 1);
  assertEquals(onlyInput(record).reviews.map((item) => item.id), [1, 2]);
  assertEquals(onlyInput(record).baseRef, "origin/main");
  assertEquals(onlyInput(record).timeoutSeconds, 15 * 60);
  assertEquals(
    onlyInput(record).agentReply,
    "Fixed both findings.\nBABYSITTER_READY",
  );
  assertEquals(record.events, ["push"]);
});

Deno.test("a partial fix dismisses only the verified review and keeps the other open (Issue #4657)", async () => {
  const github = fakeGitHub({ headRefOid: PUSHED_HEAD, body: PART_OF_BODY });
  const { value: record, logs } = await captureLogs(() =>
    runFinish({
      changed: true,
      reviews: [review(1), review(2)],
      github,
      verifyReviews: () =>
        Promise.resolve([
          { id: 1, verified: true, reason: "fixed" },
          { id: 2, verified: false, reason: "not fixed" },
        ]),
    })
  );
  assertEquals(record.dismissed, [[1]]);
  assert(
    logs.some((line) =>
      line.includes(
        `${REPO}#4611: review 2 stays open: not fixed; next action: the next scan retries`,
      )
    ),
    `expected a stays-open line for review 2, got ${JSON.stringify(logs)}`,
  );
});

Deno.test("a false-positive rebuttal in a no-change run is dismissed when verified (Issue #4657)", async () => {
  const github = fakeGitHub({ headRefOid: OLD_HEAD, body: PART_OF_BODY });
  const record = await runFinish({
    changed: false,
    reviews: [review(1)],
    github,
    verifyReviews: verifiedAll,
  });
  assertEquals(record.dismissed, [[1]]);
  assertEquals(record.events, []);
});

Deno.test("a no-op completion keeps its review open when the verifier does not judge it fixed (Issue #4657)", async () => {
  const github = fakeGitHub({ headRefOid: OLD_HEAD, body: PART_OF_BODY });
  const record = await runFinish({
    changed: false,
    reviews: [review(1)],
    github,
    verifyReviews: verifiedNone,
  });
  assertEquals(record.dismissed, []);
});

Deno.test("the verifier judges the published description, not the stale one (Issue #4657)", async () => {
  const github = fakeGitHub({ headRefOid: OLD_HEAD, body: PART_OF_BODY });
  const record = await runFinish({
    changed: false,
    reviews: [review(REVIEW_4611_ID, REVIEW_4611_BODY)],
    github,
    proposal: CLOSES_PROPOSAL,
    verifyReviews: verifiedAll,
  });
  assertEquals(record.inputs.length, 1);
  assertEquals(onlyInput(record).body, github.body());
  assertStringIncludes(
    onlyInput(record).body,
    "Closes stSoftwareAU/NEAT-AI-Discovery#2422",
  );
  assertEquals(record.dismissed, [[REVIEW_4611_ID]]);
});

Deno.test("PR #4611's review stays open while the body still says Part of (Issue #4657)", async () => {
  const github = fakeGitHub({ headRefOid: OLD_HEAD, body: PART_OF_BODY });
  const verifier: Verifier = (input) =>
    Promise.resolve(input.reviews.map((item) => ({
      id: item.id,
      verified: /\bCloses\b[^\n]*#2422/.test(input.body),
      reason: "the body still says Part of #2422",
    })));
  const { value: record, logs } = await captureLogs(() =>
    runFinish({
      changed: false,
      reviews: [review(REVIEW_4611_ID, REVIEW_4611_BODY)],
      github,
      verifyReviews: verifier,
    })
  );
  assertEquals(record.dismissed, []);
  assert(
    logs.some((line) => line.includes(`review ${REVIEW_4611_ID} stays open`)),
    `expected a stays-open line, got ${JSON.stringify(logs)}`,
  );
});

Deno.test("a failed body publication leaves reviews open without verifying (Issue #4657)", async () => {
  const github = fakeGitHub({
    headRefOid: OLD_HEAD,
    body: PART_OF_BODY,
    failEdit: true,
  });
  let verifierCalls = 0;
  await assertRejects(() =>
    runFinish({
      changed: false,
      reviews: [review(1)],
      github,
      proposal: CLOSES_PROPOSAL,
      verifyReviews: (input) => {
        verifierCalls++;
        return verifiedAll(input);
      },
    })
  );
  assertEquals(verifierCalls, 0);
});

Deno.test("a verifier outage keeps every review open and never blocks the push (Issue #4657)", async () => {
  const github = fakeGitHub({ headRefOid: PUSHED_HEAD, body: PART_OF_BODY });
  const record = await runFinish({
    changed: true,
    reviews: [review(1), review(2)],
    github,
    verifyReviews: verifiedNone,
  });
  assertEquals(record.dismissed, []);
  assertEquals(record.events, ["push"]);
});

Deno.test("a verifier that throws is an outage: reviews stay open and the push stands (Issue #4657)", async () => {
  const github = fakeGitHub({ headRefOid: PUSHED_HEAD, body: PART_OF_BODY });
  const { value: record, logs } = await captureLogs(() =>
    runFinish({
      changed: true,
      reviews: [review(1)],
      github,
      verifyReviews: () => Promise.reject(new Error("verifier unreachable")),
    })
  );
  assertEquals(record.dismissed, []);
  assertEquals(record.events, ["push"]);
  assert(
    logs.some((line) =>
      line.includes(
        "review 1 stays open: the verifier failed: verifier unreachable",
      )
    ),
    `expected an outage line, got ${JSON.stringify(logs)}`,
  );
});

Deno.test("a head that moves during verification keeps reviews open (Issue #4657)", async () => {
  const github = fakeGitHub({ headRefOid: PUSHED_HEAD, body: PART_OF_BODY });
  const record = await runFinish({
    changed: true,
    reviews: [review(1)],
    github,
    verifyReviews: (input) => {
      github.setHead(OTHER_HEAD);
      return verifiedAll(input);
    },
  });
  assertEquals(record.inputs.length, 1);
  assertEquals(record.dismissed, []);
});

Deno.test("a verdict for an id outside the reviews does not dismiss anything (Issue #4657)", async () => {
  const github = fakeGitHub({ headRefOid: OLD_HEAD, body: PART_OF_BODY });
  const record = await runFinish({
    changed: false,
    reviews: [review(1)],
    github,
    verifyReviews: () =>
      Promise.resolve([{ id: 999, verified: true, reason: "fixed" }]),
  });
  assertEquals(record.dismissed, []);
});

Deno.test("a duplicated verdict for one review keeps it open (Issue #4657)", async () => {
  const github = fakeGitHub({ headRefOid: OLD_HEAD, body: PART_OF_BODY });
  const record = await runFinish({
    changed: false,
    reviews: [review(1)],
    github,
    verifyReviews: () =>
      Promise.resolve([
        { id: 1, verified: true, reason: "fixed" },
        { id: 1, verified: true, reason: "fixed again" },
      ]),
  });
  assertEquals(record.dismissed, []);
});

Deno.test("a review that arrives during the repair is never verified or dismissed (Issue #4657)", async () => {
  const github = fakeGitHub({ headRefOid: PUSHED_HEAD, body: PART_OF_BODY });
  const record = await runFinish({
    changed: true,
    reviews: [review(1)],
    github,
    verifyReviews: () =>
      Promise.resolve([
        { id: 1, verified: true, reason: "fixed" },
        { id: 2, verified: true, reason: "a review that arrived later" },
      ]),
  });
  assertEquals(onlyInput(record).reviews.map((item) => item.id), [1]);
  assertEquals(record.dismissed, [[1]]);
});

Deno.test("a CI or conflict repair with no reviews skips verification (Issue #4657)", async () => {
  const github = fakeGitHub({ headRefOid: PUSHED_HEAD, body: PART_OF_BODY });
  const record = await runFinish({
    changed: true,
    reviews: [],
    github,
    verifyReviews: verifiedNone,
  });
  assertEquals(record.inputs.length, 0);
  assertEquals(record.dismissed, [[]]);
});

Deno.test("a description that changes during verification keeps reviews open (Issue #4657)", async () => {
  const github = fakeGitHub({ headRefOid: PUSHED_HEAD, body: PART_OF_BODY });
  const { value: record, logs } = await captureLogs(() =>
    runFinish({
      changed: true,
      reviews: [review(1)],
      github,
      verifyReviews: (input) => {
        github.setBody(`${PART_OF_BODY}\nEdited by someone else.\n`);
        return verifiedAll(input);
      },
    })
  );
  assertEquals(record.inputs.length, 1);
  assertEquals(record.dismissed, []);
  assert(
    logs.some((line) =>
      line.includes(
        "review 1 stays open: the PR head or description changed while the fixes were being verified",
      )
    ),
    `expected a stays-open line, got ${JSON.stringify(logs)}`,
  );
});

Deno.test("a head that moved before verification rejects without calling the verifier (Issue #4657)", async () => {
  // Views: the publish step reads the PR once, then verification reads it again.
  const github = fakeGitHub({
    headRefOid: OLD_HEAD,
    body: PART_OF_BODY,
    moveHeadAtView: { view: 2, head: OTHER_HEAD },
  });
  let verifierCalls = 0;
  const error = await assertRejects(() =>
    runFinish({
      changed: false,
      reviews: [review(1)],
      github,
      verifyReviews: (input) => {
        verifierCalls++;
        return verifiedAll(input);
      },
    })
  );
  assertStringIncludes(
    String(error),
    `head moved to ${OTHER_HEAD}, expected ${OLD_HEAD}`,
  );
  assertEquals(verifierCalls, 0);
});
