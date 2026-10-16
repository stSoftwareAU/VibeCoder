/**
 * Tests for security_fix_verdict.ts — the worker-derived verdict of the
 * independent verifier on the security-fix gate's trigger-closed item
 * (Issue #3657).
 *
 * Hostile-input cases use correctness assertions on long inputs rather than a
 * growth measurement: a file that measures elapsed time must be registered in
 * `WALL_CLOCK_TEST_FILES`, and this file is not.
 *
 * Australian English throughout.
 */

import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  confirmCitations,
  deriveSecurityFixVerdict,
  formatSecurityFixVerification,
  type HeadLineCounter,
  MAX_GATE_RATIONALE_CHARS,
  MAX_VERIFIER_REPLY_CHARS,
  parseCitation,
  parseSecurityFixVerifierReply,
  SECURITY_FIX_VERIFIER_GATES,
  type SecurityFixGateAnswers,
  type SecurityFixGateStatus,
  type SecurityFixVerifierGate,
} from "../lib/security_fix_verdict.ts";

/** Every gate with the given statuses; unspecified gates pass. */
function statuses(
  overrides: Partial<Record<SecurityFixVerifierGate, SecurityFixGateStatus>> =
    {},
): Record<SecurityFixVerifierGate, SecurityFixGateStatus> {
  return {
    sink_mitigated: "pass",
    reachability: "pass",
    class_eliminated: "pass",
    sweep_complete: "pass",
    ...overrides,
  };
}

/** Gate answers with the given statuses, each citing the same path:line. */
function gateAnswers(
  gateStatuses: Record<SecurityFixVerifierGate, SecurityFixGateStatus>,
  citation: string | null = "src/a.ts:1",
): SecurityFixGateAnswers {
  const answers = {} as SecurityFixGateAnswers;
  for (const gate of SECURITY_FIX_VERIFIER_GATES) {
    answers[gate] = { status: gateStatuses[gate], citation, rationale: "" };
  }
  return answers;
}

/** A counter that knows the given files and their line counts. */
function countsOf(files: Record<string, number>): HeadLineCounter {
  return (path) => Promise.resolve(files[path] ?? null);
}

// --- parseSecurityFixVerifierReply: happy path ------------------------------

Deno.test("parseSecurityFixVerifierReply - reads the four gates and ignores extra keys", () => {
  const long = "x".repeat(MAX_GATE_RATIONALE_CHARS + 50);
  const reply = `Here is my verdict: ${
    JSON.stringify({
      verdict: "FIXED",
      gates: {
        sink_mitigated: {
          status: " PASS ",
          citation: "  src/a.ts:3  ",
          rationale: `  ${long}  `,
          extra: true,
        },
        reachability: { status: "pass", citation: "src/a.ts:4" },
        class_eliminated: { status: "pass", citation: "" },
        sweep_complete: { status: "skipped", citation: null, rationale: 7 },
      },
    })
  } done.`;
  const answers = parseSecurityFixVerifierReply(reply);

  assertEquals(answers.sink_mitigated.status, "pass");
  assertEquals(answers.sink_mitigated.citation, "src/a.ts:3");
  assertEquals(
    answers.sink_mitigated.rationale.length,
    MAX_GATE_RATIONALE_CHARS,
  );
  assertEquals(answers.reachability.rationale, "");
  assertEquals(answers.class_eliminated.citation, null);
  assertEquals(answers.sweep_complete, {
    status: "skipped",
    citation: null,
    rationale: "",
  });
});

// --- parseSecurityFixVerifierReply: each throw rule -------------------------

Deno.test("parseSecurityFixVerifierReply - throws when the reply is longer than the cap", () => {
  const reply = `{${"a".repeat(MAX_VERIFIER_REPLY_CHARS)}}`;
  assertThrows(
    () => parseSecurityFixVerifierReply(reply),
    Error,
    `longer than ${MAX_VERIFIER_REPLY_CHARS} characters`,
  );
});

Deno.test("parseSecurityFixVerifierReply - throws when there is no JSON object", () => {
  assertThrows(
    () => parseSecurityFixVerifierReply("no braces at all"),
    Error,
    "no JSON object in verifier reply",
  );
  assertThrows(
    () => parseSecurityFixVerifierReply("} backwards {"),
    Error,
    "no JSON object in verifier reply",
  );
});

Deno.test("parseSecurityFixVerifierReply - throws when the JSON does not parse", () => {
  assertThrows(
    () => parseSecurityFixVerifierReply("{not json}"),
    Error,
    "not valid JSON",
  );
});

Deno.test("parseSecurityFixVerifierReply - throws when there is no gates object", () => {
  assertThrows(
    () => parseSecurityFixVerifierReply('{"verdict":"FIXED"}'),
    Error,
    "no gates object",
  );
  assertThrows(
    () => parseSecurityFixVerifierReply('{"gates":[]}'),
    Error,
    "no gates object",
  );
});

Deno.test("parseSecurityFixVerifierReply - throws when a gate is missing", () => {
  const gates = {
    sink_mitigated: { status: "pass", citation: null },
    reachability: { status: "pass", citation: null },
    class_eliminated: { status: "pass", citation: null },
  };
  assertThrows(
    () => parseSecurityFixVerifierReply(JSON.stringify({ gates })),
    Error,
    "gate sweep_complete is missing or not an object",
  );
});

Deno.test("parseSecurityFixVerifierReply - throws when a gate is not an object", () => {
  const gates = {
    sink_mitigated: "pass",
    reachability: { status: "pass", citation: null },
    class_eliminated: { status: "pass", citation: null },
    sweep_complete: { status: "pass", citation: null },
  };
  assertThrows(
    () => parseSecurityFixVerifierReply(JSON.stringify({ gates })),
    Error,
    "gate sink_mitigated is missing or not an object",
  );
});

Deno.test("parseSecurityFixVerifierReply - throws on a status other than pass, fail or skipped", () => {
  for (const status of ["maybe", "", undefined]) {
    const gates = {
      sink_mitigated: { status, citation: null },
      reachability: { status: "pass", citation: null },
      class_eliminated: { status: "pass", citation: null },
      sweep_complete: { status: "pass", citation: null },
    };
    assertThrows(
      () => parseSecurityFixVerifierReply(JSON.stringify({ gates })),
      Error,
      "gate sink_mitigated has an unknown status",
    );
  }
});

// --- parseCitation ----------------------------------------------------------

Deno.test("parseCitation - accepts path:line and reads a range from its start line", () => {
  assertEquals(parseCitation("src/a.ts:12"), { path: "src/a.ts", line: 12 });
  assertEquals(parseCitation("src/a.ts:12-20"), {
    path: "src/a.ts",
    line: 12,
  });
});

Deno.test("parseCitation - tolerates surrounding backticks, whitespace and a leading ./", () => {
  assertEquals(parseCitation("`src/a.ts:12`"), { path: "src/a.ts", line: 12 });
  assertEquals(parseCitation("  ./src/a.ts:12  "), {
    path: "src/a.ts",
    line: 12,
  });
  assertEquals(parseCitation("` src/a.ts:12 `"), {
    path: "src/a.ts",
    line: 12,
  });
});

Deno.test("parseCitation - rejects a path that is absolute, drive-lettered or backslashed", () => {
  assertEquals(parseCitation("/etc/passwd:1"), null);
  assertEquals(parseCitation("-rf:1"), null);
  // No separate drive-prefix rule: the citation pattern refuses `C:/x.ts:1`.
  assertEquals(parseCitation("C:/x.ts:1"), null);
  assertEquals(parseCitation("src\\a.ts:1"), null);
});

Deno.test("parseCitation - rejects a path that climbs with .. or names an empty or . segment", () => {
  assertEquals(parseCitation("../a.ts:1"), null);
  assertEquals(parseCitation("src/../a.ts:1"), null);
  assertEquals(parseCitation("src/./a.ts:1"), null);
  assertEquals(parseCitation("src//a.ts:1"), null);
  assertEquals(parseCitation("src/:1"), null);
});

Deno.test("parseCitation - rejects a control character in the path", () => {
  assertEquals(parseCitation("src/a\u0001.ts:1"), null);
  assertEquals(parseCitation("src/a\u007f.ts:1"), null);
});

Deno.test("parseCitation - rejects a missing, zero or malformed line number", () => {
  assertEquals(parseCitation("src/a.ts"), null);
  assertEquals(parseCitation("src/a.ts:0"), null);
  assertEquals(parseCitation("src/a.ts:1x"), null);
  assertEquals(parseCitation("src/a.ts:12-0"), null);
  assertEquals(parseCitation("src/a.ts:12345678"), null);
  assertEquals(parseCitation(""), null);
});

Deno.test("parseCitation - a long hostile input with no colon returns null", () => {
  assertEquals(parseCitation("a".repeat(100_000)), null);
});

Deno.test("parseCitation - a long run of colons and digits returns null", () => {
  assertEquals(parseCitation(":".repeat(100_000)), null);
  assertEquals(parseCitation(`a${":1".repeat(50_000)}`), null);
  assertEquals(parseCitation(`a:${"1".repeat(100_000)}`), null);
});

// --- confirmCitations -------------------------------------------------------

Deno.test("confirmCitations - a pass with no citation is demoted to skipped", async () => {
  const answers = gateAnswers(statuses(), null);
  const confirmed = await confirmCitations(answers, countsOf({}));
  for (const gate of SECURITY_FIX_VERIFIER_GATES) {
    assertEquals(confirmed[gate].status, "skipped");
    assertEquals(confirmed[gate].demotion, "no file:line citation");
  }
});

Deno.test("confirmCitations - a fail with no citation is demoted to skipped", async () => {
  const confirmed = await confirmCitations(
    gateAnswers(statuses({ sink_mitigated: "fail" }), null),
    countsOf({}),
  );
  assertEquals(confirmed.sink_mitigated.status, "skipped");
  assertEquals(confirmed.sink_mitigated.demotion, "no file:line citation");
});

Deno.test("confirmCitations - a citation to a path absent at the head is demoted", async () => {
  const confirmed = await confirmCitations(
    gateAnswers(statuses({ reachability: "fail" }), "src/gone.ts:1"),
    countsOf({}),
  );
  assertEquals(confirmed.reachability.status, "skipped");
  assertEquals(
    confirmed.reachability.demotion,
    "src/gone.ts does not exist at the head",
  );
});

Deno.test("confirmCitations - a line past the end of the file is demoted", async () => {
  const confirmed = await confirmCitations(
    gateAnswers(statuses(), "src/a.ts:11"),
    countsOf({ "src/a.ts": 10 }),
  );
  assertEquals(confirmed.sink_mitigated.status, "skipped");
  assertEquals(
    confirmed.sink_mitigated.demotion,
    "line 11 is past the end of src/a.ts (10 lines)",
  );
});

Deno.test("confirmCitations - a citation that is not a repo-relative path:line is demoted", async () => {
  const confirmed = await confirmCitations(
    gateAnswers(statuses(), "/etc/passwd:1"),
    countsOf({ "etc/passwd": 5 }),
  );
  assertEquals(
    confirmed.sink_mitigated.demotion,
    "the citation is not a repo-relative path:line",
  );
});

Deno.test("confirmCitations - a valid citation stands with no demotion", async () => {
  const confirmed = await confirmCitations(
    gateAnswers(statuses(), "src/a.ts:10"),
    countsOf({ "src/a.ts": 10 }),
  );
  for (const gate of SECURITY_FIX_VERIFIER_GATES) {
    assertEquals(confirmed[gate].status, "pass");
    assertEquals(confirmed[gate].citation, "src/a.ts:10");
    assertEquals("demotion" in confirmed[gate], false);
  }
});

Deno.test("confirmCitations - a skipped answer stands and its citation is not looked up", async () => {
  let calls = 0;
  const countLines: HeadLineCounter = () => {
    calls++;
    return Promise.resolve(null);
  };
  const confirmed = await confirmCitations(
    gateAnswers(statuses({ sweep_complete: "skipped" }), "src/a.ts:1"),
    countLines,
  );
  assertEquals(confirmed.sweep_complete.status, "skipped");
  assertEquals("demotion" in confirmed.sweep_complete, false);
  assertEquals(calls, 1);
});

Deno.test("confirmCitations - counts each distinct path once", async () => {
  let calls = 0;
  const countLines: HeadLineCounter = () => {
    calls++;
    return Promise.resolve(10);
  };
  await confirmCitations(gateAnswers(statuses(), "src/a.ts:1"), countLines);
  assertEquals(calls, 1);
});

Deno.test("confirmCitations - a throwing counter rejects", async () => {
  await assertRejects(
    () =>
      confirmCitations(
        gateAnswers(statuses(), "src/a.ts:1"),
        () => Promise.reject(new Error("git ls-tree failed")),
      ),
    Error,
    "git ls-tree failed",
  );
});

// --- deriveSecurityFixVerdict -----------------------------------------------

Deno.test("deriveSecurityFixVerdict - all four pass is FIXED", () => {
  assertEquals(deriveSecurityFixVerdict(gateAnswers(statuses())), "FIXED");
});

Deno.test("deriveSecurityFixVerdict - a sink_mitigated fail is NOT_FIXED", () => {
  assertEquals(
    deriveSecurityFixVerdict(gateAnswers(statuses({ sink_mitigated: "fail" }))),
    "NOT_FIXED",
  );
});

Deno.test("deriveSecurityFixVerdict - a reachability fail is NOT_FIXED (worker departure from VulnHunter)", () => {
  assertEquals(
    deriveSecurityFixVerdict(gateAnswers(statuses({ reachability: "fail" }))),
    "NOT_FIXED",
  );
});

Deno.test("deriveSecurityFixVerdict - sink pass with a class_eliminated fail is PARTIAL", () => {
  assertEquals(
    deriveSecurityFixVerdict(
      gateAnswers(statuses({ class_eliminated: "fail" })),
    ),
    "PARTIAL",
  );
});

Deno.test("deriveSecurityFixVerdict - sink pass with a sweep_complete fail is PARTIAL", () => {
  assertEquals(
    deriveSecurityFixVerdict(gateAnswers(statuses({ sweep_complete: "fail" }))),
    "PARTIAL",
  );
});

Deno.test("deriveSecurityFixVerdict - one skipped and none failing is INCONCLUSIVE", () => {
  assertEquals(
    deriveSecurityFixVerdict(
      gateAnswers(statuses({ class_eliminated: "skipped" })),
    ),
    "INCONCLUSIVE",
  );
});

Deno.test("deriveSecurityFixVerdict - all skipped is INCONCLUSIVE", () => {
  const all: Record<SecurityFixVerifierGate, SecurityFixGateStatus> = {
    sink_mitigated: "skipped",
    reachability: "skipped",
    class_eliminated: "skipped",
    sweep_complete: "skipped",
  };
  assertEquals(deriveSecurityFixVerdict(gateAnswers(all)), "INCONCLUSIVE");
});

Deno.test("deriveSecurityFixVerdict - a skipped sink with a class_eliminated fail is INCONCLUSIVE", () => {
  assertEquals(
    deriveSecurityFixVerdict(
      gateAnswers(
        statuses({ sink_mitigated: "skipped", class_eliminated: "fail" }),
      ),
    ),
    "INCONCLUSIVE",
  );
});

Deno.test("a reply claiming all pass with no citations is INCONCLUSIVE once confirmed (Issue #3657)", async () => {
  const reply = JSON.stringify({
    gates: Object.fromEntries(
      SECURITY_FIX_VERIFIER_GATES.map((gate) => [
        gate,
        { status: "pass", citation: null, rationale: "looks fixed" },
      ]),
    ),
  });
  const parsed = parseSecurityFixVerifierReply(reply);
  const confirmed = await confirmCitations(parsed, countsOf({}));
  assertEquals(deriveSecurityFixVerdict(confirmed), "INCONCLUSIVE");
});

// --- formatSecurityFixVerification ------------------------------------------

Deno.test("formatSecurityFixVerification - states the verdict, every gate line and any demotion", async () => {
  const answers = gateAnswers(statuses(), "src/a.ts:3");
  answers.sink_mitigated = {
    status: "fail",
    citation: "src/a.ts:3",
    rationale: "still reachable",
  };
  answers.reachability = {
    status: "pass",
    citation: null,
    rationale: "traced",
  };
  const confirmed = await confirmCitations(
    answers,
    countsOf({ "src/a.ts": 10 }),
  );
  const text = formatSecurityFixVerification({
    kind: "checked",
    verdict: deriveSecurityFixVerdict(confirmed),
    gates: confirmed,
  });

  assertStringIncludes(text, "Independent verifier verdict:\n\n");
  assertStringIncludes(
    text,
    "verdict: NOT_FIXED (derived by the worker from the gate answers)",
  );
  assertStringIncludes(
    text,
    "sink_mitigated: fail — src/a.ts:3 — still reachable",
  );
  const sink = text.indexOf("sink_mitigated:");
  const reach = text.indexOf("reachability:");
  const sweep = text.indexOf("sweep_complete:");
  assertEquals(sink < reach && reach < sweep, true);
  assertStringIncludes(
    text,
    "reachability: skipped — no citation — traced [demoted to skipped: no file:line citation]",
  );
  assertStringIncludes(text, "```text\n");
  assertStringIncludes(text, "\n```");
});

Deno.test("formatSecurityFixVerification - a not checked verification states its reason", () => {
  const text = formatSecurityFixVerification({
    kind: "not_checked",
    reason: "runner timed out",
  });
  assertStringIncludes(text, "Independent verifier verdict:");
  assertStringIncludes(text, "not checked: runner timed out");
});

Deno.test("formatSecurityFixVerification - a fence longer than any backtick run in the body", () => {
  const gates = gateAnswers(statuses(), "src/a.ts:1");
  gates.sink_mitigated = {
    status: "pass",
    citation: "src/a.ts:1",
    rationale: "```",
  };
  const text = formatSecurityFixVerification({
    kind: "checked",
    verdict: "FIXED",
    gates,
  });
  assertStringIncludes(text, "````text\n");
});
