/**
 * Tests for blocked-outcome detection and deferral (Issue #222).
 *
 * A no-changes run whose output opens with a `Blocked` / `Depends on` section
 * is a deferral, not an analysis-only hand-off and never a closure.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildDependencyLine,
  detectBlockedOutcome,
  formatDependencyRef,
} from "../lib/blocked_outcome.ts";
import {
  buildDeferralSummary,
  deferBlockedIssue,
} from "../lib/blocked_deferral.ts";
import { extractDependencyReferences } from "../lib/issue_dependencies.ts";
import type { GitHubClient, GitHubIssue, Logger } from "../types.ts";

const SELF = { repo: "stSoftwareAU/NEAT-AI-Backpropagation", issueNumber: 94 };

/** The shape the real run produced on NEAT-AI-Backpropagation#94. */
const BLOCKED_OUTPUT =
  `## Blocked: \`neat_core::creature_validate\` has no rule bodies

\`creature_validate\` in NEAT-AI-core \`Develop\` returns an unconditional
failure until the rule bodies land, so validating every trained creature
here would reject all of them.

Depends on stSoftwareAU/NEAT-AI-core#560
`;

// ---------------------------------------------------------------------------
// detectBlockedOutcome
// ---------------------------------------------------------------------------

Deno.test("detectBlockedOutcome finds the dependency in a Blocked section", () => {
  const blocked = detectBlockedOutcome(BLOCKED_OUTPUT, SELF);
  assert(blocked, "expected a blocked outcome");
  assertEquals(blocked.dependency.repo, "stSoftwareAU/NEAT-AI-core");
  assertEquals(blocked.dependency.number, 560);
  assertStringIncludes(blocked.reason, "creature_validate");
});

Deno.test("detectBlockedOutcome accepts a bare same-repo dependency line", () => {
  const blocked = detectBlockedOutcome(
    "Depends on #77 — the parser rewrite has to land first.",
    SELF,
  );
  assert(blocked);
  assertEquals(blocked.dependency.repo, undefined);
  assertEquals(blocked.dependency.number, 77);
  assertEquals(formatDependencyRef(blocked.dependency), "#77");
});

Deno.test("detectBlockedOutcome accepts bold and bulleted openings", () => {
  for (
    const opening of [
      "**Blocked** on stSoftwareAU/NEAT-AI-core#560",
      "- Depends on stSoftwareAU/NEAT-AI-core#560",
      "Blocked by stSoftwareAU/NEAT-AI-core#560",
      "###### Blocked: waiting for stSoftwareAU/NEAT-AI-core#560",
    ]
  ) {
    const blocked = detectBlockedOutcome(opening, SELF);
    assert(blocked, `expected a blocked outcome for: ${opening}`);
    assertEquals(blocked.dependency.number, 560);
  }
});

Deno.test("detectBlockedOutcome ignores a passing mention of 'blocked'", () => {
  const output = "I refactored the parser. Nothing here is blocked by #12, " +
    "and the tests pass.";
  assertEquals(detectBlockedOutcome(output, SELF), undefined);
});

Deno.test("detectBlockedOutcome requires an issue reference", () => {
  const output = "## Blocked\n\nThe upstream library has no release yet.";
  assertEquals(detectBlockedOutcome(output, SELF), undefined);
});

Deno.test("detectBlockedOutcome never treats the issue as its own dependency", () => {
  const sameRepoSelf = `## Blocked: see #94\n\nThis is issue #94 itself.`;
  assertEquals(detectBlockedOutcome(sameRepoSelf, SELF), undefined);

  const explicitSelf = `## Blocked: see ${SELF.repo}#94\n\nSame issue.`;
  assertEquals(detectBlockedOutcome(explicitSelf, SELF), undefined);
});

Deno.test("detectBlockedOutcome ignores dependencies quoted in code blocks", () => {
  const output = "## Blocked\n\n```\nDepends on org/other#5\n```\n";
  assertEquals(detectBlockedOutcome(output, SELF), undefined);
});

Deno.test("detectBlockedOutcome returns undefined for empty output", () => {
  assertEquals(detectBlockedOutcome("", SELF), undefined);
  assertEquals(detectBlockedOutcome("   \n\n ", SELF), undefined);
});

Deno.test("detectBlockedOutcome stops the section at the next heading", () => {
  const output = `## Blocked: dependency work unfinished

Depends on org/dep#5

## Notes

Unrelated reference to org/other#9.
`;
  const blocked = detectBlockedOutcome(output, SELF);
  assert(blocked);
  assertEquals(blocked.dependencies.length, 1);
  assertEquals(blocked.dependency.number, 5);
  assert(!blocked.reason.includes("Unrelated"));
});

// ---------------------------------------------------------------------------
// The recorded dependency line is the form the gate reads
// ---------------------------------------------------------------------------

Deno.test("buildDependencyLine writes the form the dependency gate parses", () => {
  const blocked = detectBlockedOutcome("Depends on #77", SELF);
  assert(blocked);
  const line = buildDependencyLine(blocked.dependency);
  assertEquals(line, "Depends on #77");
  assertEquals(extractDependencyReferences(line), [77]);
});

// ---------------------------------------------------------------------------
// deferBlockedIssue — the GitHub side
// ---------------------------------------------------------------------------

interface Calls {
  comments: string[];
  edits: Array<{ body?: string }>;
  labels: string[];
  unassigned: number;
}

function makeClient(
  calls: Calls,
  overrides: Partial<GitHubClient> = {},
): GitHubClient {
  const issue: GitHubIssue = {
    number: SELF.issueNumber,
    title: "Validate every trained creature",
    body: "Original body.",
    labels: ["work-on"],
    author: "human",
    assignees: [],
    createdAt: "",
    updatedAt: "",
  };
  return {
    getIssue: () => Promise.resolve(issue),
    getIssueComments: () => Promise.resolve([]),
    addLabel: (_r, _i, label) => {
      calls.labels.push(label);
      return Promise.resolve();
    },
    removeLabel: () => Promise.resolve(),
    postComment: (_r, _i, body) => {
      calls.comments.push(body);
      return Promise.resolve(undefined);
    },
    editIssue: (_r, _i, updates) => {
      calls.edits.push(updates);
      return Promise.resolve();
    },
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => {
      calls.unassigned++;
      return Promise.resolve();
    },
    closeIssue: () => {
      throw new Error("closeIssue must never be called for a deferral");
    },
    ...overrides,
  };
}

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  skipReason: () => {},
  timing: () => {},
  scanSummary: () => {},
  workerSummary: () => {},
};

function makeCalls(): Calls {
  return { comments: [], edits: [], labels: [], unassigned: 0 };
}

Deno.test("deferBlockedIssue records the dependency in the body and releases", async () => {
  const calls = makeCalls();
  const blocked = detectBlockedOutcome(BLOCKED_OUTPUT, SELF)!;
  const result = await deferBlockedIssue({
    ghClient: makeClient(calls),
    repo: SELF.repo,
    issueNumber: SELF.issueNumber,
    githubUser: "VibeCoderST",
    blocked,
    outputSnippet: BLOCKED_OUTPUT,
    logger: silentLogger,
  });

  assertEquals(result.recorded, "body");
  assertEquals(result.ref, "stSoftwareAU/NEAT-AI-core#560");
  assertEquals(result.outcome.kind, "no_pr_expected");
  assertEquals(
    result.outcome.kind === "no_pr_expected" ? result.outcome.summary : "",
    buildDeferralSummary("stSoftwareAU/NEAT-AI-core#560"),
  );

  // The body now declares the dependency in the gate's own form.
  assertEquals(calls.edits.length, 1);
  assertStringIncludes(
    calls.edits[0]?.body ?? "",
    "Depends on stSoftwareAU/NEAT-AI-core#560",
  );
  assertStringIncludes(calls.edits[0]?.body ?? "", "Original body.");

  // No needs-human, no label churn, claim released.
  assertEquals(calls.labels, []);
  assertEquals(calls.unassigned, 1);

  // The comment quotes the run's own stated reason, not "analysis-only".
  assertEquals(calls.comments.length, 1);
  assertStringIncludes(calls.comments[0]!, "Deferred");
  assertStringIncludes(calls.comments[0]!, "creature_validate");
  assert(!calls.comments[0]!.includes("analysis-only"));
});

Deno.test("deferBlockedIssue does not duplicate an existing dependency line", async () => {
  const calls = makeCalls();
  const blocked = detectBlockedOutcome(BLOCKED_OUTPUT, SELF)!;
  const client = makeClient(calls, {
    getIssue: () =>
      Promise.resolve({
        number: SELF.issueNumber,
        title: "t",
        body: "Body.\n\nDepends on stSoftwareAU/NEAT-AI-core#560\n",
        labels: ["work-on"],
        author: "human",
        assignees: [],
        createdAt: "",
        updatedAt: "",
      }),
  });
  const result = await deferBlockedIssue({
    ghClient: client,
    repo: SELF.repo,
    issueNumber: SELF.issueNumber,
    githubUser: "VibeCoderST",
    blocked,
    outputSnippet: "x",
    logger: silentLogger,
  });
  assertEquals(result.recorded, "body");
  assertEquals(calls.edits.length, 0);
});

Deno.test("deferBlockedIssue falls back to the blocked label when the body edit fails", async () => {
  const calls = makeCalls();
  const blocked = detectBlockedOutcome(BLOCKED_OUTPUT, SELF)!;
  const client = makeClient(calls, {
    editIssue: () => Promise.reject(new Error("403 read-only")),
  });
  const result = await deferBlockedIssue({
    ghClient: client,
    repo: SELF.repo,
    issueNumber: SELF.issueNumber,
    githubUser: "VibeCoderST",
    blocked,
    outputSnippet: "x",
    logger: silentLogger,
    deps: {
      ensureLabelExists: () => Promise.resolve({ ok: true, value: undefined }),
    },
  });
  assertEquals(result.recorded, "label");
  assertEquals(calls.labels, ["blocked"]);
  assertEquals(calls.unassigned, 1);
});

Deno.test("deferBlockedIssue reports 'none' when nothing could be recorded", async () => {
  const calls = makeCalls();
  const blocked = detectBlockedOutcome(BLOCKED_OUTPUT, SELF)!;
  const client = makeClient(calls, {
    editIssue: () => Promise.reject(new Error("403")),
    addLabel: () => Promise.reject(new Error("403")),
  });
  const result = await deferBlockedIssue({
    ghClient: client,
    repo: SELF.repo,
    issueNumber: SELF.issueNumber,
    githubUser: "VibeCoderST",
    blocked,
    outputSnippet: "x",
    logger: silentLogger,
  });
  assertEquals(result.recorded, "none");
  assertEquals(calls.unassigned, 1);
});

// ---------------------------------------------------------------------------
// The declared dependency wins over a passing mention (Issue #1634)
// ---------------------------------------------------------------------------

Deno.test("detectBlockedOutcome prefers the reference on the Depends on line", () => {
  // The shape the real run produced on NEAT-AI-core#592: the prose names the
  // issue that *caused* the block (#588) and the closing line declares the
  // issue actually depended on (#591). Taking the first reference in the
  // section deferred the issue on the wrong number.
  const output = `## Blocked: the rule bodies are still stubs

The stub landed with #588, so \`creature_validate\` returns an unconditional
failure and nothing here can be validated yet.

Depends on #591
`;
  const blocked = detectBlockedOutcome(output, SELF);
  assert(blocked);
  assertEquals(blocked.dependency.number, 591);
  assertEquals(buildDependencyLine(blocked.dependency), "Depends on #591");
  // Every reference is still reported, in the order they appear.
  assertEquals(blocked.dependencies.map((d) => d.number), [588, 591]);
});

Deno.test("detectBlockedOutcome honours a cross-repo Depends on line", () => {
  const output = `## Blocked: parser rewrite unfinished

Traced back to org/other#9 while reading the parser.

- Depends on stSoftwareAU/NEAT-AI-core#591
`;
  const blocked = detectBlockedOutcome(output, SELF);
  assert(blocked);
  assertEquals(blocked.dependency.repo, "stSoftwareAU/NEAT-AI-core");
  assertEquals(blocked.dependency.number, 591);
});

Deno.test("detectBlockedOutcome honours a 'Blocked by' declaration line", () => {
  const output = `## Blocked: schema missing

The failure surfaces in #588.

Blocked by #591
`;
  const blocked = detectBlockedOutcome(output, SELF);
  assert(blocked);
  assertEquals(blocked.dependency.number, 591);
});

Deno.test("detectBlockedOutcome falls back to the first reference with no declaration line", () => {
  const output = `## Blocked: waiting on org/dep#5

Nothing declares a dependency explicitly, so the first reference stands.
`;
  const blocked = detectBlockedOutcome(output, SELF);
  assert(blocked);
  assertEquals(blocked.dependency.repo, "org/dep");
  assertEquals(blocked.dependency.number, 5);
});

Deno.test("detectBlockedOutcome skips a declaration line naming only itself", () => {
  const output = `## Blocked: see org/dep#5

Depends on #${SELF.issueNumber}
`;
  const blocked = detectBlockedOutcome(output, SELF);
  assert(blocked);
  assertEquals(blocked.dependency.number, 5);
});
