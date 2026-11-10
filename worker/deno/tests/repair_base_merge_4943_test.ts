/**
 * Unit tests for the base-merge policy and base-refresh diagnostics
 * (Issue #4943): lib/repair_base_merge_4943.ts.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import {
  decideRepairBaseMerge,
  formatBaseRefreshDecision,
  logBaseRefreshDecision,
  parseRefreshOwner,
  readRepairBaseMergeDecision,
} from "../lib/repair_base_merge_4943.ts";

const FAKE_TOKEN = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";

Deno.test("decideRepairBaseMerge merges only for a CONFLICTING PR", () => {
  const decision = decideRepairBaseMerge("CONFLICTING");
  assertEquals(decision.merge, true);
  assertEquals(decision.reason, "genuine conflict: GitHub reports CONFLICTING");
});

Deno.test("decideRepairBaseMerge refuses every other mergeable value with a distinct reason", () => {
  const cases: Array<[unknown, string]> = [
    ["MERGEABLE", '"MERGEABLE"'],
    ["UNKNOWN", '"UNKNOWN"'],
    [null, "null"],
    [undefined, "undefined"],
    [42, "a non-string value (number)"],
  ];
  const reasons = new Set<string>();
  for (const [value, named] of cases) {
    const decision = decideRepairBaseMerge(value);
    assertEquals(decision.merge, false, `merge for ${String(value)}`);
    assert(
      decision.reason.includes(named),
      `reason for ${String(value)} names the value: ${decision.reason}`,
    );
    assert(decision.reason.includes("not CONFLICTING"));
    reasons.add(decision.reason);
  }
  assertEquals(reasons.size, cases.length, "every refusal reason differs");
});

Deno.test("formatBaseRefreshDecision renders the exact single-line shape", () => {
  const line = formatBaseRefreshDecision(
    {
      source: "pr-ci-processor",
      outcome: "refresh-requested",
      repo: "owner/repo",
      prNumber: 12,
      base: "main",
      reason: "ok",
    },
    "build=abc123",
  );
  assertEquals(
    line,
    '[base-refresh] source=pr-ci-processor outcome=refresh-requested repo=owner/repo pr=#12 base=main owner=none reason="ok" build=abc123',
  );
});

Deno.test("formatBaseRefreshDecision renders the owner as #N/worker, and none when absent", () => {
  const owned = formatBaseRefreshDecision(
    {
      source: "branch-update-loop",
      outcome: "refresh-skipped",
      repo: "owner/repo",
      prNumber: 7,
      base: "main",
      reason: "busy",
      ownerPr: 12,
      ownerWorker: "worker-1",
    },
    "build=abc123",
  );
  assertEquals(
    owned,
    '[base-refresh] source=branch-update-loop outcome=refresh-skipped repo=owner/repo pr=#7 base=main owner=#12/worker-1 reason="busy" build=abc123',
  );
  const unowned = formatBaseRefreshDecision(
    {
      source: "branch-update-loop",
      outcome: "refresh-skipped",
      repo: "owner/repo",
      prNumber: 7,
      reason: "busy",
    },
    "build=abc123",
  );
  assertEquals(
    unowned,
    '[base-refresh] source=branch-update-loop outcome=refresh-skipped repo=owner/repo pr=#7 base=none owner=none reason="busy" build=abc123',
  );
});

Deno.test("formatBaseRefreshDecision strips newlines and quotes from the reason", () => {
  const line = formatBaseRefreshDecision(
    {
      source: "pr-feedback-processor",
      outcome: "base-merge-skipped",
      repo: "owner/repo",
      prNumber: 3,
      base: "main",
      reason: "line1\nline2 \"quoted\" 'single' `tick`",
    },
    "build=abc123",
  );
  assert(!line.includes("\n"), "one line only");
  assertEquals(
    line,
    '[base-refresh] source=pr-feedback-processor outcome=base-merge-skipped repo=owner/repo pr=#3 base=main owner=none reason="line1line2 quoted single tick" build=abc123',
  );
});

Deno.test("formatBaseRefreshDecision redacts a fake GitHub token in the reason", () => {
  const line = formatBaseRefreshDecision(
    {
      source: "babysitter-repair",
      outcome: "base-merge-skipped",
      repo: "owner/repo",
      prNumber: 3,
      base: "main",
      reason: `failed with token ${FAKE_TOKEN}`,
    },
    "build=abc123",
  );
  assert(!line.includes(FAKE_TOKEN), "token must not survive");
  assert(line.includes("***REDACTED***"), "placeholder present");
});

Deno.test("formatBaseRefreshDecision caps a 10000-character reason at 200 characters", () => {
  const line = formatBaseRefreshDecision(
    {
      source: "merge-block-repair",
      outcome: "refresh-skipped",
      repo: "owner/repo",
      prNumber: 3,
      base: "main",
      reason: "x".repeat(10_000),
    },
    "build=abc123",
  );
  const match = /reason="(x*)" build=abc123$/.exec(line);
  assert(match, "reason field present at the end of the line");
  assertEquals(match[1]!.length, 200);
  assert(line.length < 600, `bounded line length ${line.length}`);
});

Deno.test("parseRefreshOwner reads the exact shared-owner message", () => {
  assertEquals(
    parseRefreshOwner("base refresh owned by org/repo#12 (refresh-abc)"),
    { ownerPr: 12, ownerWorker: "refresh-abc" },
  );
});

Deno.test("parseRefreshOwner rejects look-alike messages", () => {
  const lookAlikes = [
    "base refresh owned by org/repo#12 (refresh-abc) and more text",
    "base refresh owned by org/repo#0 (refresh-abc)",
    "base refresh owned by org/repo#12",
    "base refresh owned by org/repo#12 ()",
    "base refresh owned by org/repo#12 (refresh-abc)\nextra",
    "something else entirely",
  ];
  for (const message of lookAlikes) {
    assertEquals(parseRefreshOwner(message), null, message);
  }
});

Deno.test("readRepairBaseMergeDecision merges for CONFLICTING and logs one line", async () => {
  const calls: string[][] = [];
  const lines: string[] = [];
  const decision = await readRepairBaseMergeDecision({
    repo: "owner/repo",
    prNumber: 12,
    gh: (args) => {
      calls.push(args);
      return Promise.resolve('{"mergeable":"CONFLICTING"}');
    },
    source: "pr-ci-processor",
    base: "main",
    log: (line) => lines.push(line),
  });
  assertEquals(decision.merge, true);
  assertEquals(calls, [[
    "pr",
    "view",
    "12",
    "--repo",
    "owner/repo",
    "--json",
    "mergeable",
  ]]);
  assertEquals(lines.length, 1);
  assertMatch(
    lines[0]!,
    /^\[base-refresh\] source=pr-ci-processor outcome=base-merge-allowed repo=owner\/repo pr=#12 base=main /,
  );
});

Deno.test("readRepairBaseMergeDecision refuses a MERGEABLE PR and logs the skip", async () => {
  const lines: string[] = [];
  const decision = await readRepairBaseMergeDecision({
    repo: "owner/repo",
    prNumber: 12,
    gh: () => Promise.resolve('{"mergeable":"MERGEABLE"}'),
    source: "pr-feedback-processor",
    base: "main",
    log: (line) => lines.push(line),
  });
  assertEquals(decision.merge, false);
  assert(decision.reason.includes('"MERGEABLE"'));
  assertEquals(lines.length, 1);
  assertMatch(lines[0]!, /outcome=base-merge-skipped /);
});

Deno.test("readRepairBaseMergeDecision refuses when gh throws, naming the cause", async () => {
  const lines: string[] = [];
  const decision = await readRepairBaseMergeDecision({
    repo: "owner/repo",
    prNumber: 12,
    gh: () => Promise.reject(new Error("gateway timeout upstream")),
    source: "pr-ci-processor",
    base: "main",
    log: (line) => lines.push(line),
  });
  assertEquals(decision.merge, false);
  assert(decision.reason.includes("mergeability unreadable"));
  assert(decision.reason.includes("gateway timeout upstream"));
  assertEquals(lines.length, 1);
  assertMatch(lines[0]!, /outcome=base-merge-skipped /);
});

Deno.test("readRepairBaseMergeDecision refuses garbled JSON", async () => {
  const lines: string[] = [];
  const decision = await readRepairBaseMergeDecision({
    repo: "owner/repo",
    prNumber: 12,
    gh: () => Promise.resolve("{not json"),
    source: "pr-ci-processor",
    base: "main",
    log: (line) => lines.push(line),
  });
  assertEquals(decision.merge, false);
  assert(decision.reason.includes("mergeability unreadable"));
  assertEquals(lines.length, 1);
  assertMatch(lines[0]!, /outcome=base-merge-skipped /);
});

Deno.test("logBaseRefreshDecision never throws, even when the sink throws", () => {
  logBaseRefreshDecision(
    {
      source: "pr-ci-processor",
      outcome: "base-merge-skipped",
      repo: "owner/repo",
      prNumber: 1,
      reason: "x",
    },
    () => {
      throw new Error("sink down");
    },
    "build=abc123",
  );
});
