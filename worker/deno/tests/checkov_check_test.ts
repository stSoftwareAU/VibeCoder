/**
 * Tests for checkov_check.ts — the Checkov CloudFormation scan (Issue #3653).
 *
 * The fixtures are the real Checkov 3.3.29 reports, trimmed to the fields the
 * evaluator reads. Values and shape are kept as Checkov emitted them; the
 * passed-check entries keep their identity and location but not their code
 * block, which the evaluator never reads.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { restoreConsole } from "../lib/console_redaction.ts";
import {
  buildCheckovContainerArgs,
  CHECKOV_DEADLINE_MS,
  CHECKOV_WORKFLOW_PATH,
  type CheckovInvocation,
  checkovScanArgs,
  checkovStageApplies,
  inlineSkipScan,
  judgeCheckovRun,
  parseCheckovReport,
  runCheckovCheck,
} from "../lib/checkov_check.ts";
import { CHECKOV_IMAGE, CHECKOV_IMAGE_TAG } from "../lib/pinned_actions.ts";
import { runQualityGate } from "../lib/quality_gate.ts";
import { main } from "../checkov_report.ts";

/** One `[lineNumber, lineText]` pair of a Checkov code block. */
type Line = [number, string];

/** The real `AWS::EC2::SecurityGroup.Sg` body, lines 5–13 of t1, t2 and t6. */
const SG_BODY: Line[] = [
  [5, "    Type: AWS::EC2::SecurityGroup\n"],
  [6, "    Properties:\n"],
  [7, "      GroupDescription: x\n"],
  [8, "      SecurityGroupIngress:\n"],
  [9, "        - Description: ssh\n"],
  [10, "          IpProtocol: tcp\n"],
  [11, "          FromPort: 22\n"],
  [12, "          ToPort: 22\n"],
  [13, "          CidrIp: 0.0.0.0/0\n"],
];

/** The CKV_AWS_24 check name, as Checkov reports it. */
const CKV_AWS_24_NAME =
  "Ensure no security groups allow ingress from 0.0.0.0:0 to port 22";

/** A passed check on the security group, trimmed. */
function passed(checkId: string, checkName: string) {
  return {
    check_id: checkId,
    check_name: checkName,
    check_result: { result: "PASSED", evaluated_keys: ["Properties"] },
    file_path: "/a.yaml",
    file_line_range: [3, 13],
    resource: "AWS::EC2::SecurityGroup.Sg",
  };
}

/** The three passed checks t1 reports. */
const T1_PASSED = [
  passed(
    "CKV_AWS_23",
    "Ensure every security groups rule has a description",
  ),
  passed(
    "CKV_AWS_25",
    "Ensure no security groups allow ingress from 0.0.0.0:0 to port 3389",
  ),
  passed(
    "CKV_AWS_260",
    "Ensure no security groups allow ingress from 0.0.0.0:0 to port 80",
  ),
];

/** t1: an inline skip with a reason — exit 0. */
const T1_REPORT = {
  check_type: "cloudformation",
  results: {
    passed_checks: T1_PASSED,
    failed_checks: [],
    skipped_checks: [{
      check_id: "CKV_AWS_24",
      bc_check_id: null,
      check_name: CKV_AWS_24_NAME,
      check_result: {
        result: "SKIPPED",
        suppress_comment: " SSH is required by the bastion",
      },
      code_block: [
        [3, "  Sg:\n"],
        [4, "    # checkov:skip=CKV_AWS_24: SSH is required by the bastion\n"],
        ...SG_BODY,
      ],
      file_path: "/a.yaml",
      file_abs_path: "t1/a.yaml",
      repo_file_path: "/t1/a.yaml",
      file_line_range: [3, 13],
      resource: "AWS::EC2::SecurityGroup.Sg",
      evaluations: {},
      check_class:
        "checkov.cloudformation.checks.resource.aws.SecurityGroupUnrestrictedIngress22",
    }],
    parsing_errors: [],
  },
  summary: {
    passed: 3,
    failed: 0,
    skipped: 1,
    parsing_errors: 0,
    resource_count: 1,
    checkov_version: "3.3.29",
  },
  url:
    "Add an api key '--bc-api-key <api-key>' to see more detailed insights via https://bridgecrew.cloud",
};

/** t2: an inline skip with no reason — exit 0, which must still be refused. */
const T2_REPORT = {
  check_type: "cloudformation",
  results: {
    passed_checks: T1_PASSED,
    failed_checks: [],
    skipped_checks: [{
      check_id: "CKV_AWS_24",
      bc_check_id: null,
      check_name: CKV_AWS_24_NAME,
      check_result: {
        result: "SKIPPED",
        suppress_comment: "No comment provided",
      },
      code_block: [
        [3, "  Sg:\n"],
        [4, "    # checkov:skip=CKV_AWS_24\n"],
        ...SG_BODY,
      ],
      file_path: "/a.yaml",
      file_abs_path: "t2/a.yaml",
      repo_file_path: "/t2/a.yaml",
      file_line_range: [3, 13],
      resource: "AWS::EC2::SecurityGroup.Sg",
      evaluations: {},
      check_class:
        "checkov.cloudformation.checks.resource.aws.SecurityGroupUnrestrictedIngress22",
    }],
    parsing_errors: [],
  },
  summary: {
    passed: 3,
    failed: 0,
    skipped: 1,
    parsing_errors: 0,
    resource_count: 1,
    checkov_version: "3.3.29",
  },
  url:
    "Add an api key '--bc-api-key <api-key>' to see more detailed insights via https://bridgecrew.cloud",
};

/** t4: a Metadata skip block with a comment — exit 0, no inline comment. */
const T4_REPORT = {
  check_type: "cloudformation",
  results: {
    passed_checks: T1_PASSED,
    failed_checks: [],
    skipped_checks: [{
      check_id: "CKV_AWS_24",
      bc_check_id: null,
      check_name: CKV_AWS_24_NAME,
      check_result: { result: "SKIPPED", suppress_comment: "meta reason" },
      code_block: [
        [3, "  Sg:\n"],
        [4, "    Type: AWS::EC2::SecurityGroup\n"],
        [5, "    Metadata:\n"],
        [6, "      checkov:\n"],
        [7, "        skip:\n"],
        [8, "          - id: CKV_AWS_24\n"],
        [9, "            comment: meta reason\n"],
        [10, "    Properties:\n"],
        [11, "      GroupDescription: x\n"],
        [12, "      SecurityGroupIngress:\n"],
        [13, "        - Description: ssh\n"],
        [14, "          IpProtocol: tcp\n"],
        [15, "          FromPort: 22\n"],
        [16, "          ToPort: 22\n"],
        [17, "          CidrIp: 0.0.0.0/0\n"],
      ],
      file_path: "/a.yaml",
      file_abs_path: "t4/a.yaml",
      repo_file_path: "/t4/a.yaml",
      file_line_range: [3, 17],
      resource: "AWS::EC2::SecurityGroup.Sg",
      evaluations: {},
      check_class:
        "checkov.cloudformation.checks.resource.aws.SecurityGroupUnrestrictedIngress22",
    }],
    parsing_errors: [],
  },
  summary: {
    passed: 3,
    failed: 0,
    skipped: 1,
    parsing_errors: 0,
    resource_count: 1,
    checkov_version: "3.3.29",
  },
  url:
    "Add an api key '--bc-api-key <api-key>' to see more detailed insights via https://bridgecrew.cloud",
};

/** t5: no CloudFormation templates — summary-only object, exit 0. */
const T5_REPORT = {
  passed: 0,
  failed: 0,
  skipped: 0,
  parsing_errors: 0,
  resource_count: 0,
  checkov_version: "3.3.29",
};

/** t6: one failed check, no skip — exit 1. */
const T6_REPORT = {
  check_type: "cloudformation",
  results: {
    passed_checks: T1_PASSED,
    failed_checks: [{
      check_id: "CKV_AWS_24",
      bc_check_id: null,
      check_name: CKV_AWS_24_NAME,
      check_result: {
        result: "FAILED",
        evaluated_keys: ["Properties/SecurityGroupIngress"],
      },
      code_block: [
        [3, "  Sg:\n"],
        [4, "    Type: AWS::EC2::SecurityGroup\n"],
        [5, "    Properties:\n"],
        [6, "      GroupDescription: x\n"],
        [7, "      SecurityGroupIngress:\n"],
        [8, "        - Description: ssh\n"],
        [9, "          IpProtocol: tcp\n"],
        [10, "          FromPort: 22\n"],
        [11, "          ToPort: 22\n"],
        [12, "          CidrIp: 0.0.0.0/0\n"],
      ],
      file_path: "/a.yaml",
      file_abs_path: "t6/a.yaml",
      repo_file_path: "/t6/a.yaml",
      file_line_range: [3, 12],
      resource: "AWS::EC2::SecurityGroup.Sg",
      evaluations: {},
      check_class:
        "checkov.cloudformation.checks.resource.aws.SecurityGroupUnrestrictedIngress22",
    }],
    skipped_checks: [],
    parsing_errors: [],
  },
  summary: {
    passed: 3,
    failed: 1,
    skipped: 0,
    parsing_errors: 0,
    resource_count: 1,
    checkov_version: "3.3.29",
  },
  url:
    "Add an api key '--bc-api-key <api-key>' to see more detailed insights via https://bridgecrew.cloud",
};

/** t7: a template Checkov cannot parse — exit 0, visible only in the report. */
const T7_REPORT = {
  check_type: "cloudformation",
  results: {
    passed_checks: [],
    failed_checks: [],
    skipped_checks: [],
    parsing_errors: ["t7/a.yaml"],
  },
  summary: {
    passed: 0,
    failed: 0,
    skipped: 0,
    parsing_errors: 1,
    resource_count: 0,
    checkov_version: "3.3.29",
  },
  url:
    "Add an api key '--bc-api-key <api-key>' to see more detailed insights via https://bridgecrew.cloud",
};

/** Serialise a fixture the way `checkov -o json` prints it. */
function asStdout(report: unknown): string {
  return JSON.stringify(report, null, 2);
}

/** Capture `console.log` / `console.error` around one run of `main`. */
async function captureConsole(
  run: () => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  restoreConsole();
  const out: string[] = [];
  const err: string[] = [];
  const saved = { log: console.log, error: console.error };
  console.log = (...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    err.push(args.map(String).join(" "));
  };
  try {
    const code = await run();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    restoreConsole();
    console.log = saved.log;
    console.error = saved.error;
  }
}

/** Run `body` in a fresh temporary directory, removed afterwards. */
async function withTempDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "checkov_check_test_" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

Deno.test("checkov_check - scan args are the whole repository, CloudFormation only", () => {
  assertEquals(checkovScanArgs(), [
    "-d",
    ".",
    "--framework",
    "cloudformation",
    "-o",
    "json",
    "--skip-download",
  ]);
});

Deno.test("checkov_check - container args mount read-only and name the entrypoint", () => {
  assertEquals(buildCheckovContainerArgs("/repo"), [
    "run",
    "--rm",
    "-v",
    "/repo:/src:ro",
    "-w",
    "/src",
    "--entrypoint",
    "checkov",
    CHECKOV_IMAGE,
    "-d",
    ".",
    "--framework",
    "cloudformation",
    "-o",
    "json",
    "--skip-download",
  ]);
  assertEquals(
    buildCheckovContainerArgs("/repo", "example/checkov:test")[7],
    "checkov",
  );
  assertEquals(
    buildCheckovContainerArgs("/repo", "example/checkov:test")[8],
    "example/checkov:test",
  );
});

// ---------------------------------------------------------------------------
// Inline skip evaluation
// ---------------------------------------------------------------------------

Deno.test("checkov_check - inlineSkipScan reason finds the reason of a justified skip", () => {
  assertEquals(
    inlineSkipScan(
      T1_REPORT.results.skipped_checks[0]!.code_block,
      "CKV_AWS_24",
    ).reason,
    "SSH is required by the bastion",
  );
});

Deno.test("checkov_check - inlineSkipScan reason refuses a marker with no reason", () => {
  // t2: `# checkov:skip=CKV_AWS_24` — the id matches, the reason is absent.
  assertEquals(
    inlineSkipScan(
      T2_REPORT.results.skipped_checks[0]!.code_block,
      "CKV_AWS_24",
    ).reason,
    null,
  );
  assertEquals(
    inlineSkipScan(
      T2_REPORT.results.skipped_checks[0]!.code_block,
      "CKV_AWS_24",
    ),
    { reason: null, markerForId: true },
  );
});

Deno.test("checkov_check - inlineSkipScan reason ignores a skip for another check", () => {
  const block: Line[] = [
    [4, "    # checkov:skip=CKV_AWS_25: a different check's reason\n"],
  ];
  assertEquals(inlineSkipScan(block, "CKV_AWS_24"), {
    reason: null,
    markerForId: false,
  });
});

Deno.test("checkov_check - inlineSkipScan reason ignores a marker outside a comment", () => {
  // No `#`: the text is a value, not a comment, so it cannot suppress.
  assertEquals(
    inlineSkipScan(
      [[4, "    Description: checkov:skip=CKV_AWS_24: looks like a reason\n"]],
      "CKV_AWS_24",
    ).reason,
    null,
  );
  // A `#` glued to the text (no blank before it) does not open a comment.
  assertEquals(
    inlineSkipScan(
      [[4, "    Description: x#checkov:skip=CKV_AWS_24: reason\n"]],
      "CKV_AWS_24",
    ).reason,
    null,
  );
});

Deno.test("checkov_check - inlineSkipScan reason fails closed on a malformed code block", () => {
  assertEquals(inlineSkipScan(undefined, "CKV_AWS_24").reason, null);
  assertEquals(
    inlineSkipScan("# checkov:skip=CKV_AWS_24: r", "CKV_AWS_24").reason,
    null,
  );
  assertEquals(
    inlineSkipScan(
      [[4, "    # checkov:skip=CKV_AWS_24: reason\n"], "not a pair"],
      "CKV_AWS_24",
    ).reason,
    null,
  );
  assertEquals(
    inlineSkipScan(
      [["4", "    # checkov:skip=CKV_AWS_24: reason\n"]],
      "CKV_AWS_24",
    ).reason,
    null,
  );
  assertEquals(
    inlineSkipScan([[4, 42]], "CKV_AWS_24").reason,
    null,
  );
  assertEquals(
    inlineSkipScan([[4, "# checkov:skip=CKV_AWS_24: r", 9]], "CKV_AWS_24")
      .reason,
    null,
  );
});

Deno.test("checkov_check - inlineSkipScan reason takes a reason from any of several marker lines", () => {
  const block: Line[] = [
    [4, "    # checkov:skip=CKV_AWS_24\n"],
    [5, "    # checkov:skip=CKV_AWS_25: other check\n"],
    [6, "    # checkov:skip=CKV_AWS_24: the real reason\n"],
  ];
  assertEquals(inlineSkipScan(block, "CKV_AWS_24").reason, "the real reason");
});

Deno.test("checkov_check - inlineSkipScan reason returns on a hostile 100k-character line", () => {
  // Untrusted text: the scan is indexOf/slice only and must simply return.
  const spacesAndColons = " :".repeat(50_000);
  assertEquals(
    inlineSkipScan([[1, `# ${spacesAndColons}`]], "CKV_AWS_24").reason,
    null,
  );
  assertEquals(
    inlineSkipScan(
      [[1, `# checkov:skip=CKV_AWS_24:${" ".repeat(100_000)}`]],
      "CKV_AWS_24",
    ).reason,
    null,
  );
  assertEquals(
    inlineSkipScan(
      [[1, `# ${"checkov:skip=".repeat(10_000)}`]],
      "CKV_AWS_24",
    ).reason,
    null,
  );
});

// ---------------------------------------------------------------------------
// Report parsing
// ---------------------------------------------------------------------------

Deno.test("checkov_check - parseCheckovReport counts a justified skip (t1)", () => {
  const report = parseCheckovReport(asStdout(T1_REPORT));
  assertEquals(report.resourceCount, 1);
  assertEquals(report.passed, 3);
  assertEquals(report.skippedJustified, 1);
  assertEquals(report.failed, []);
  assertEquals(report.rejectedSkips, []);
  assertEquals(report.parsingErrors, []);
});

Deno.test("checkov_check - parseCheckovReport rejects a skip with no reason (t2)", () => {
  const report = parseCheckovReport(asStdout(T2_REPORT));
  assertEquals(report.skippedJustified, 0);
  assertEquals(report.rejectedSkips.length, 1);
  const rejected = report.rejectedSkips[0]!;
  assertEquals(rejected.checkId, "CKV_AWS_24");
  assertEquals(rejected.file, "/a.yaml");
  assertEquals(rejected.resource, "AWS::EC2::SecurityGroup.Sg");
  assertEquals(rejected.startLine, 3);
  assertEquals(rejected.why, "no reason given");
});

Deno.test("checkov_check - parseCheckovReport rejects a Metadata skip as not inline (t4)", () => {
  const report = parseCheckovReport(asStdout(T4_REPORT));
  assertEquals(report.skippedJustified, 0);
  assertEquals(report.rejectedSkips.length, 1);
  assertStringIncludes(
    report.rejectedSkips[0]!.why ?? "",
    "not an inline `# checkov:skip=CKV_AWS_24:<reason>` comment on the resource",
  );
});

Deno.test("checkov_check - parseCheckovReport reads a summary-only report as zero resources (t5)", () => {
  const report = parseCheckovReport(asStdout(T5_REPORT));
  assertEquals(report.resourceCount, 0);
  assertEquals(report.passed, 0);
  assertEquals(report.failed, []);
  assertEquals(report.rejectedSkips, []);
  assertEquals(report.parsingErrors, []);
});

Deno.test("checkov_check - parseCheckovReport lists a failed check (t6)", () => {
  const report = parseCheckovReport(asStdout(T6_REPORT));
  assertEquals(report.failed.length, 1);
  assertEquals(report.failed[0], {
    checkId: "CKV_AWS_24",
    checkName: CKV_AWS_24_NAME,
    file: "/a.yaml",
    resource: "AWS::EC2::SecurityGroup.Sg",
    startLine: 3,
  });
});

Deno.test("checkov_check - parseCheckovReport records an unparseable template (t7)", () => {
  const report = parseCheckovReport(asStdout(T7_REPORT));
  assertEquals(report.parsingErrors, ["t7/a.yaml"]);
  assertEquals(report.resourceCount, 0);
});

Deno.test("checkov_check - parseCheckovReport keeps a summary-counted parse error with no name", () => {
  const report = parseCheckovReport(
    asStdout({
      ...T7_REPORT,
      results: { ...T7_REPORT.results, parsing_errors: [] },
      summary: { ...T7_REPORT.summary, parsing_errors: 2 },
    }),
  );
  assertEquals(report.parsingErrors, [
    "(unnamed template)",
    "(unnamed template)",
  ]);
});

Deno.test("checkov_check - parseCheckovReport sums an array of check-type reports", () => {
  const report = parseCheckovReport(asStdout([T1_REPORT, T6_REPORT]));
  assertEquals(report.passed, 6);
  assertEquals(report.skippedJustified, 1);
  assertEquals(report.failed.length, 1);
  assertEquals(report.resourceCount, 2);
});

Deno.test("checkov_check - parseCheckovReport throws on empty stdout", () => {
  assertThrows(
    () => parseCheckovReport("   \n"),
    Error,
    "no JSON report on stdout",
  );
});

Deno.test("checkov_check - parseCheckovReport throws on non-JSON stdout", () => {
  assertThrows(
    () => parseCheckovReport("Checkov: something went wrong"),
    Error,
    "stdout is not JSON",
  );
});

Deno.test("checkov_check - parseCheckovReport throws on an unrecognised shape", () => {
  assertThrows(
    () => parseCheckovReport(asStdout({ foo: 1 })),
    Error,
    "unrecognised Checkov report shape",
  );
  assertThrows(
    () => parseCheckovReport("[]"),
    Error,
    "empty array",
  );
  assertThrows(
    () => parseCheckovReport('"a string"'),
    Error,
    "expected an object",
  );
  assertThrows(
    () => parseCheckovReport(asStdout([T5_REPORT, [1, 2]])),
    Error,
    "expected an object",
  );
});

Deno.test("checkov_check - parseCheckovReport refuses a summary-only report that claims failures", () => {
  // No check list behind a failure count: nothing can be judged, so refuse.
  assertThrows(
    () => parseCheckovReport(asStdout({ ...T5_REPORT, failed: 1 })),
    Error,
    "claims 1 failed and 0 skipped check(s) with no check list",
  );
});

// ---------------------------------------------------------------------------
// Judgement
// ---------------------------------------------------------------------------

Deno.test("checkov_check - judgeCheckovRun PASSED for a justified skip (t1)", () => {
  const judged = judgeCheckovRun({
    exitCode: 0,
    stdout: asStdout(T1_REPORT),
    stderr: "",
  });
  assertEquals(judged, {
    status: "PASSED",
    output:
      "checkov: PASSED (1 resource(s), 3 check(s) passed, 1 skipped with a reason)",
  });
});

Deno.test("checkov_check - judgeCheckovRun PASSED for a summary-only report (t5)", () => {
  const judged = judgeCheckovRun({
    exitCode: 0,
    stdout: asStdout(T5_REPORT),
    stderr: "",
  });
  assertEquals(judged.status, "PASSED");
  assertStringIncludes(judged.output, "checkov: PASSED (0 resource(s)");
});

Deno.test("checkov_check - judgeCheckovRun FAILED for a failed check (t6)", () => {
  const judged = judgeCheckovRun({
    exitCode: 1,
    stdout: asStdout(T6_REPORT),
    stderr: "",
  });
  assertEquals(judged.status, "FAILED");
  assertStringIncludes(judged.output, "checkov: FAILED (1 failed check(s)");
  assertStringIncludes(
    judged.output,
    `  /a.yaml:3 CKV_AWS_24 AWS::EC2::SecurityGroup.Sg — ${CKV_AWS_24_NAME}`,
  );
  assertStringIncludes(judged.output, "# checkov:skip=<ID>:<reason>");
});

Deno.test("checkov_check - judgeCheckovRun FAILED on exit 0 with a failed check (t6)", () => {
  // The report decides, whatever the exit code says.
  const judged = judgeCheckovRun({
    exitCode: 0,
    stdout: asStdout(T6_REPORT),
    stderr: "",
  });
  assertEquals(judged.status, "FAILED");
  assertStringIncludes(judged.output, "1 failed check(s)");
});

Deno.test("checkov_check - judgeCheckovRun FAILED for a skip with no reason (t2)", () => {
  const judged = judgeCheckovRun({
    exitCode: 0,
    stdout: asStdout(T2_REPORT),
    stderr: "",
  });
  assertEquals(judged.status, "FAILED");
  assertStringIncludes(judged.output, "1 rejected skip(s)");
  assertStringIncludes(
    judged.output,
    "  /a.yaml:3 CKV_AWS_24 AWS::EC2::SecurityGroup.Sg — no reason given",
  );
});

Deno.test("checkov_check - judgeCheckovRun FAILED for a Metadata skip (t4)", () => {
  const judged = judgeCheckovRun({
    exitCode: 0,
    stdout: asStdout(T4_REPORT),
    stderr: "",
  });
  assertEquals(judged.status, "FAILED");
  assertStringIncludes(
    judged.output,
    "not an inline `# checkov:skip=CKV_AWS_24:<reason>` comment on the resource",
  );
});

Deno.test("checkov_check - judgeCheckovRun FAILED for an unparseable template on exit 0 (t7)", () => {
  const judged = judgeCheckovRun({
    exitCode: 0,
    stdout: asStdout(T7_REPORT),
    stderr: "",
  });
  assertEquals(judged.status, "FAILED");
  assertStringIncludes(judged.output, "1 unparseable template(s)");
  assertStringIncludes(
    judged.output,
    "  t7/a.yaml — Checkov could not parse this template",
  );
});

Deno.test("checkov_check - judgeCheckovRun FAILED on exit 1 with nothing failing in the report", () => {
  const judged = judgeCheckovRun({
    exitCode: 1,
    stdout: asStdout(T5_REPORT),
    stderr: "",
  });
  assertEquals(judged.status, "FAILED");
  assertStringIncludes(
    judged.output,
    "checkov: FAILED (exit 1 with no failing check in the report)",
  );
});

Deno.test("checkov_check - judgeCheckovRun FAILED on a tool error (exit 2) with the stderr tail", () => {
  const judged = judgeCheckovRun({
    exitCode: 2,
    stdout: "",
    stderr: "Usage error: unrecognised option\n",
  });
  assertEquals(judged.status, "FAILED");
  assertStringIncludes(judged.output, "checkov: FAILED (exit 2, tool error)");
  assertStringIncludes(judged.output, "Usage error: unrecognised option");
});

Deno.test("checkov_check - judgeCheckovRun FAILED on an unreadable report", () => {
  const judged = judgeCheckovRun({ exitCode: 0, stdout: "", stderr: "" });
  assertEquals(judged.status, "FAILED");
  assertStringIncludes(
    judged.output,
    "checkov: FAILED (exit 0, unreadable report)",
  );
  assertStringIncludes(judged.output, "no JSON report on stdout");
});

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

/** A fake invocation that returns a fixed run. */
function fakeInvocation(
  run: Partial<Awaited<ReturnType<CheckovInvocation["run"]>>>,
  pinnedToCi: boolean,
): CheckovInvocation {
  return {
    description: "fake checkov",
    pinnedToCi,
    run: () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...run }),
  };
}

Deno.test("checkov_check - runCheckovCheck SKIPPED when no invocation exists, naming the CI job", async () => {
  const result = await runCheckovCheck("/unused", {
    detectInvocation: () => Promise.resolve(null),
  });
  assertEquals(result.status, "SKIPPED");
  assertStringIncludes(result.output, "checkov: SKIPPED (not run — ");
  assertStringIncludes(result.output, "checkov is not installed");
  assertStringIncludes(result.output, CHECKOV_IMAGE);
  assertStringIncludes(
    result.output,
    `the required \`checkov\` CI job (${CHECKOV_WORKFLOW_PATH}) still scans every template`,
  );
  assertStringIncludes(
    result.output,
    `pipx install checkov==${CHECKOV_IMAGE_TAG}`,
  );
});

Deno.test("checkov_check - runCheckovCheck SKIPPED on a deadline hit, naming the deadline", async () => {
  const result = await runCheckovCheck("/unused", {
    detectInvocation: () =>
      Promise.resolve(
        fakeInvocation({ exitCode: -1, timedOut: true }, true),
      ),
  });
  assertEquals(result.status, "SKIPPED");
  assertStringIncludes(
    result.output,
    `scan exceeded the ${CHECKOV_DEADLINE_MS / 1000}s local deadline`,
  );
});

Deno.test("checkov_check - runCheckovCheck FAILED on a failed check, naming the invocation", async () => {
  const result = await runCheckovCheck("/unused", {
    detectInvocation: () =>
      Promise.resolve(
        fakeInvocation({ exitCode: 1, stdout: asStdout(T6_REPORT) }, true),
      ),
  });
  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "checkov: FAILED (1 failed check(s)");
  assertStringIncludes(result.output, " via fake checkov");
});

Deno.test("checkov_check - runCheckovCheck PASSED from a non-pinned version says so", async () => {
  const result = await runCheckovCheck("/unused", {
    detectInvocation: () =>
      Promise.resolve(
        fakeInvocation({ exitCode: 0, stdout: asStdout(T1_REPORT) }, false),
      ),
  });
  assertEquals(result.status, "PASSED");
  assertStringIncludes(result.output, " via fake checkov");
  assertStringIncludes(
    result.output,
    `differs from the CI pin ${CHECKOV_IMAGE_TAG}, so a local pass is not a guarantee`,
  );
});

Deno.test("checkov_check - runCheckovCheck PASSED from the pinned version adds no drift note", async () => {
  const result = await runCheckovCheck("/unused", {
    detectInvocation: () =>
      Promise.resolve(
        fakeInvocation({ exitCode: 0, stdout: asStdout(T1_REPORT) }, true),
      ),
  });
  assertEquals(result.status, "PASSED");
  assert(!result.output.includes("differs from the CI pin"));
});

Deno.test("checkov_check - checkovStageApplies is true only when the workflow file exists", async () => {
  await withTempDir(async (dir) => {
    assertEquals(await checkovStageApplies(dir), false);
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    assertEquals(await checkovStageApplies(dir), false);
    await Deno.writeTextFile(
      `${dir}/${CHECKOV_WORKFLOW_PATH}`,
      "name: checkov\n",
    );
    assertEquals(await checkovStageApplies(dir), true);
  });
});

Deno.test("checkov_check - checkovStageApplies is false when the path is a directory", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(`${dir}/${CHECKOV_WORKFLOW_PATH}`, { recursive: true });
    assertEquals(await checkovStageApplies(dir), false);
  });
});

// ---------------------------------------------------------------------------
// The CI entry (checkov_report.ts)
// ---------------------------------------------------------------------------

Deno.test("checkov_report - a missing --report flag is refused with exit 1", async () => {
  const run = await captureConsole(() => main(["--checkov-exit", "0"]));
  assertEquals(run.code, 1);
  assertStringIncludes(run.err, "--report <path> is required");
});

Deno.test("checkov_report - a missing --checkov-exit flag is refused with exit 1", async () => {
  const run = await captureConsole(() => main(["--report", "/unused.json"]));
  assertEquals(run.code, 1);
  assertStringIncludes(run.err, "--checkov-exit <n> is required");
});

Deno.test("checkov_report - a non-integer --checkov-exit is refused with exit 1", async () => {
  for (const bad of ["-1", "x", "1.5", ""]) {
    const run = await captureConsole(() =>
      main(["--report", "/unused.json", "--checkov-exit", bad])
    );
    assertEquals(run.code, 1, `value "${bad}"`);
    assertStringIncludes(
      run.err,
      "--checkov-exit must be a non-negative integer",
    );
  }
});

Deno.test("checkov_report - an unreadable report file is refused with exit 1", async () => {
  await withTempDir(async (dir) => {
    const run = await captureConsole(() =>
      main(["--report", `${dir}/absent.json`, "--checkov-exit", "0"])
    );
    assertEquals(run.code, 1);
    assertStringIncludes(run.err, "cannot read the Checkov report at");
  });
});

Deno.test("checkov_report - a passing report exits 0 and prints PASSED", async () => {
  await withTempDir(async (dir) => {
    const report = `${dir}/report.json`;
    await Deno.writeTextFile(report, asStdout(T1_REPORT));
    const run = await captureConsole(() =>
      main(["--report", report, "--checkov-exit", "0"])
    );
    assertEquals(run.code, 0);
    assertEquals(
      run.out,
      "checkov: PASSED (1 resource(s), 3 check(s) passed, 1 skipped with a reason)",
    );
    assertEquals(run.err, "");
  });
});

Deno.test("checkov_report - a failing report exits 1 and prints the finding", async () => {
  await withTempDir(async (dir) => {
    const report = `${dir}/report.json`;
    await Deno.writeTextFile(report, asStdout(T6_REPORT));
    const run = await captureConsole(() =>
      main(["--report", report, "--checkov-exit", "1"])
    );
    assertEquals(run.code, 1);
    assertStringIncludes(run.err, "checkov: FAILED (1 failed check(s)");
    assertStringIncludes(run.err, "CKV_AWS_24");
    assertEquals(run.out, "");
  });
});

// ---------------------------------------------------------------------------
// Gate wiring (Issue #3653)
// ---------------------------------------------------------------------------

/** The gate's options for a quick, sequential, prompt-free run. */
const GATE_OPTIONS = {
  strict: false,
  sequential: true,
  validatePrompts: false,
} as const;

Deno.test("quality gate - no checkov stage where checkov.yml is absent", async () => {
  await withTempDir(async (dir) => {
    const result = await runQualityGate({
      scriptDir: dir,
      options: GATE_OPTIONS,
    });
    assert(result.ok, "quality gate should return a result");
    const names = result.value.checks.map((check) => check.name);
    assert(
      !names.includes("checkov"),
      `Gate must not run checkov without ${CHECKOV_WORKFLOW_PATH}; recorded: ${
        names.join(", ")
      }`,
    );
  });
});

Deno.test("quality gate - registers the checkov stage where checkov.yml exists", async () => {
  await withTempDir(async (dir) => {
    // An empty workflow file is enough: the stage keys on the file's presence.
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(`${dir}/${CHECKOV_WORKFLOW_PATH}`, "");
    const result = await runQualityGate({
      scriptDir: dir,
      options: GATE_OPTIONS,
    });
    assert(result.ok, "quality gate should return a result");
    const names = result.value.checks.map((check) => check.name);
    const checkov = result.value.checks.find((check) =>
      check.name === "checkov"
    );
    assert(
      checkov !== undefined,
      `Gate must run checkov where ${CHECKOV_WORKFLOW_PATH} exists; recorded: ${
        names.join(", ")
      }`,
    );
    // SKIPPED where Checkov is unavailable; PASSED when it scanned the empty dir.
    assert(
      checkov.status === "SKIPPED" || checkov.status === "PASSED",
      `checkov stage must be SKIPPED or PASSED on an empty tree, got ${checkov.status}: ${checkov.output}`,
    );
  });
});
