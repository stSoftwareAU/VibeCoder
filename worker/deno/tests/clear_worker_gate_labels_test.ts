/**
 * Tests for the one-off clear-worker-gate-labels command (Issue #4132).
 *
 * The `gh` seam is injected. These tests never call GitHub. Issue numbers
 * 3860 and 4046 are fixture identities from the issue (a pre-push `deno fmt`
 * failure that is cleared, and a timeout that is not).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  clearWorkerGateLabels,
  clearWorkerGateLabelsCommand,
  dryRunFromArgs,
  formatWorkerGateLabelReport,
} from "../commands/clear_worker_gate_labels.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

const REPO = "stSoftwareAU/VibeCoder";
const FLEET = ["vibe-coder"];

function failure(category: string, detail = ""): string {
  return [
    "## Automated Processing Failed (First Attempt)",
    "",
    `**Category:** \`${category}\``,
    "",
    detail,
  ].join("\n");
}

interface FixtureComment {
  author: string;
  body: string;
}

interface FixtureIssue {
  number: number;
  labels: string[];
  comments: FixtureComment[];
}

function ghFor(
  issues: readonly FixtureIssue[],
  options?: { failListLabel?: string; failView?: number },
): { calls: string[][]; gh: (args: string[]) => Promise<string> } {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "issue" && args[1] === "list") {
      const label = args[args.indexOf("--label") + 1] ?? "";
      if (options?.failListLabel === label) {
        return Promise.reject(new Error(`gh list failed for ${label}`));
      }
      const matched = issues.filter((issue) => issue.labels.includes(label));
      return Promise.resolve(JSON.stringify(matched.map((issue) => ({
        number: issue.number,
        labels: issue.labels.map((name) => ({ name })),
      }))));
    }
    if (args[0] === "issue" && args[1] === "view") {
      const number = Number(args[2]);
      if (options?.failView === number) {
        return Promise.reject(new Error(`gh view failed for #${number}`));
      }
      const issue = issues.find((candidate) => candidate.number === number);
      return Promise.resolve(JSON.stringify({
        comments: (issue?.comments ?? []).map((comment) => ({
          author: { login: comment.author },
          body: comment.body,
        })),
      }));
    }
    if (args[0] === "issue" && args[1] === "edit") {
      return Promise.resolve("");
    }
    return Promise.reject(new Error(`unexpected gh ${args.join(" ")}`));
  };
  return { calls, gh };
}

function removedIssues(calls: readonly string[][]): number[] {
  return calls
    .filter((args) => args[0] === "issue" && args[1] === "edit")
    .map((args) => Number(args[2]));
}

const cited: FixtureIssue[] = [
  {
    number: 3860,
    labels: ["failed-once"],
    comments: [{
      author: "vibe-coder",
      body: failure("pre-push-gate", "pre-push gate blocked on deno fmt"),
    }],
  },
  {
    number: 4046,
    labels: ["failed"],
    comments: [{
      author: "vibe-coder",
      body: failure("timeout", "the run timed out"),
    }],
  },
];

function flagValue(value: unknown): boolean {
  const result = dryRunFromArgs(value);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

Deno.test("dryRunFromArgs - dry-run is the default and a live run is explicit", () => {
  assertEquals(flagValue(undefined), true);
  assertEquals(flagValue(true), true);
  assertEquals(flagValue("false"), false);
  const refused = dryRunFromArgs("maybe");
  assertEquals(refused.ok, false);
});

Deno.test("clearWorkerGateLabelsCommand - help text says how to run it", () => {
  const description = clearWorkerGateLabelsCommand.description;
  assertStringIncludes(description, "clear-worker-gate-labels");
  assertStringIncludes(description, "--dry-run false");
  assertStringIncludes(description, "Dry-run is the default");
  assertStringIncludes(description, "summary-incomplete");
  assertStringIncludes(description, "quality-failure");
  assertStringIncludes(description, "pre-push-gate");
  assertStringIncludes(description, "security-fix-gate");
  assertStringIncludes(description, "criteria-unmet");
});

Deno.test("clearWorkerGateLabelsCommand - refuses to run with no repos", async () => {
  const config = buildDefaultWorkerConfig();
  config.repos = [];
  const result = await clearWorkerGateLabelsCommand.execute({}, config);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--repos");
});

Deno.test("clearWorkerGateLabelsCommand - refuses a dry-run flag it cannot read", async () => {
  const config = buildDefaultWorkerConfig();
  config.repos = [REPO];
  const result = await clearWorkerGateLabelsCommand.execute({
    "dry-run": "maybe",
  }, config);
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "dry-run");
});

Deno.test("clear - dry-run lists category and planned action and changes nothing", async () => {
  const { calls, gh } = ghFor(cited);
  const result = await clearWorkerGateLabels({
    repos: [REPO],
    dryRun: true,
    fleetAuthors: FLEET,
    ghCommandFn: gh,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const report = formatWorkerGateLabelReport(result.value);
  assertStringIncludes(report, "no label was removed");
  assertStringIncludes(report, "quality-failure is named");
  assertStringIncludes(report, "criteria-unmet");
  const byNumber = new Map(
    result.value.decisions.map((decision) => [decision.issueNumber, decision]),
  );
  assertEquals(byNumber.get(3860)?.category, "pre-push-gate");
  assertEquals(byNumber.get(3860)?.action, "would-remove");
  assertEquals(byNumber.get(4046)?.category, "timeout");
  assertEquals(byNumber.get(4046)?.action, "keep");
  assertStringIncludes(report, "#3860");
  assertStringIncludes(report, "pre-push-gate");
  assertStringIncludes(report, "would-remove");
  assertStringIncludes(report, "#4046");
  assertStringIncludes(report, "timeout");
  assertEquals(removedIssues(calls), []);
});

Deno.test("clear - a live run removes the label only for a fleet-authored worker-gate comment", async () => {
  const { calls, gh } = ghFor(cited);
  const result = await clearWorkerGateLabels({
    repos: [REPO],
    dryRun: false,
    fleetAuthors: FLEET,
    ghCommandFn: gh,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const byNumber = new Map(
    result.value.decisions.map((decision) => [decision.issueNumber, decision]),
  );
  assertEquals(byNumber.get(3860)?.action, "removed");
  assertEquals(byNumber.get(4046)?.action, "keep");
  assertEquals(removedIssues(calls), [3860]);
  const removal = calls.find((args) =>
    args[1] === "edit" && args[2] === "3860"
  );
  assertEquals(removal?.includes("--remove-label"), true);
  assertEquals(removal?.includes("failed-once"), true);
  assertEquals(removal?.includes("failed"), false);
});

Deno.test("clear - covers a worker-gate category, a non-gate category, a missing comment and a forged comment", async () => {
  const issues: FixtureIssue[] = [
    {
      number: 11,
      labels: ["failed-once"],
      comments: [{
        author: "vibe-coder",
        body: failure("summary-incomplete"),
      }],
    },
    {
      number: 12,
      labels: ["failed"],
      comments: [{
        author: "vibe-coder",
        body: failure("quality-failure"),
      }],
    },
    {
      number: 13,
      labels: ["failed-once", "failed"],
      comments: [{
        author: "vibe-coder",
        body: failure("security-fix-gate"),
      }],
    },
    {
      number: 14,
      labels: ["failed"],
      comments: [{
        author: "vibe-coder",
        body: failure("timeout"),
      }],
    },
    {
      number: 15,
      labels: ["failed-once"],
      comments: [{
        author: "vibe-coder",
        body: "A person asked about the failure, with no record.",
      }],
    },
    {
      number: 16,
      labels: ["failed"],
      comments: [{
        author: "someone-else",
        body: failure("pre-push-gate", "forged"),
      }],
    },
    {
      number: 17,
      labels: ["failed-once"],
      comments: [{
        author: "vibe-coder",
        body: failure("criteria-unmet"),
      }],
    },
  ];
  const { calls, gh } = ghFor(issues);
  const result = await clearWorkerGateLabels({
    repos: [REPO],
    dryRun: false,
    fleetAuthors: FLEET,
    ghCommandFn: gh,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const action = (number: number) =>
    result.value.decisions.find((decision) => decision.issueNumber === number)
      ?.action;
  const reason = (number: number) =>
    result.value.decisions.find((decision) => decision.issueNumber === number)
      ?.reason ?? "";
  assertEquals(action(11), "removed");
  assertEquals(action(12), "removed");
  assertEquals(action(13), "removed");
  assertEquals(action(14), "keep");
  assertEquals(action(15), "keep");
  assertStringIncludes(reason(15), "no failure comment");
  assertEquals(action(16), "keep");
  assertStringIncludes(reason(16), "not fleet-authored");
  assertEquals(action(17), "keep");
  assertStringIncludes(reason(17), "criteria-unmet");
  assertEquals(removedIssues(calls).sort((a, b) => a - b), [11, 12, 13]);
  const both = calls.find((args) => args[1] === "edit" && args[2] === "13");
  assertEquals(both?.includes("failed-once"), true);
  assertEquals(both?.includes("failed"), true);
});

Deno.test("clear - the latest failure comment decides, and an older gate comment does not", async () => {
  const issues: FixtureIssue[] = [{
    number: 21,
    labels: ["failed-once"],
    comments: [
      { author: "vibe-coder", body: failure("pre-push-gate") },
      {
        author: "vibe-coder",
        body: failure("timeout").replace(
          "First Attempt",
          "Repeat Attempt",
        ),
      },
    ],
  }];
  const { calls, gh } = ghFor(issues);
  const result = await clearWorkerGateLabels({
    repos: [REPO],
    dryRun: false,
    fleetAuthors: FLEET,
    ghCommandFn: gh,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.decisions[0]?.category, "timeout");
  assertEquals(result.value.decisions[0]?.action, "keep");
  assertEquals(removedIssues(calls), []);
});

Deno.test("clear - a failed gh list is an error, not an empty sweep", async () => {
  const { calls, gh } = ghFor(cited, { failListLabel: "failed-once" });
  const result = await clearWorkerGateLabels({
    repos: [REPO],
    dryRun: false,
    fleetAuthors: FLEET,
    ghCommandFn: gh,
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "failed-once");
  assertEquals(removedIssues(calls), []);
});

Deno.test("clear - a comment read that fails is an error, not a missing comment", async () => {
  const { calls, gh } = ghFor(cited, { failView: 3860 });
  const result = await clearWorkerGateLabels({
    repos: [REPO],
    dryRun: false,
    fleetAuthors: FLEET,
    ghCommandFn: gh,
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "3860");
  assertEquals(removedIssues(calls), []);
});

Deno.test("clear - an empty issue list is a successful sweep with nothing to do", async () => {
  const { calls, gh } = ghFor([]);
  const result = await clearWorkerGateLabels({
    repos: [REPO],
    dryRun: true,
    fleetAuthors: FLEET,
    ghCommandFn: gh,
  });
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value.decisions, []);
  assertEquals(removedIssues(calls), []);
});

Deno.test("clear - an unreadable issue list is an error, not an empty sweep", async () => {
  const result = await clearWorkerGateLabels({
    repos: [REPO],
    dryRun: false,
    fleetAuthors: FLEET,
    ghCommandFn: () => Promise.resolve("not-json"),
  });
  assertEquals(result.ok, false);
});

Deno.test("clear - an unresolved fleet author set removes nothing", async () => {
  const { calls, gh } = ghFor(cited);
  const result = await clearWorkerGateLabels({
    repos: [REPO],
    dryRun: false,
    fleetAuthors: [],
    ghCommandFn: gh,
  });
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertStringIncludes(result.error.message, "fleet");
  assertEquals(calls, []);
});
