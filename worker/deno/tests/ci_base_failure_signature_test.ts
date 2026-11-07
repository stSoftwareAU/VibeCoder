/**
 * Tests for `failureSignatureLines` and `compareBaseFailure` (Issue #4680).
 *
 * The base-branch deferral may accept a `Depends on` claim only when the base
 * run failed for the same reason as the pull request. These tests pin that:
 * the same failure matches across noise (timestamps, run numbers, ANSI), a
 * different failure does not, the generic runner exit line never counts as
 * evidence, and any read that fails is `unreadable` rather than a verdict.
 *
 * Uses Australian English throughout (behaviour, normalise, unreadable).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type BaseFailureComparison,
  compareBaseFailure,
  failureSignatureLines,
} from "../lib/ci_base_failure_signature.ts";
import type {
  ActionsLogOptions,
  ActionsLogOutcome,
  fetchGithubActionsLogExcerpt,
} from "../lib/github_actions_log_fetcher.ts";

Deno.test("compareBaseFailure - same Deno and cargo failures ignore changing tallies", async () => {
  const cases: [string, string][] = [
    [
      "parser - parse header ... FAILED\nAssertionError: expected header to be valid\nFAILED | 1407 passed | 1 failed (2m14s)\n_3 further annotation(s) omitted (cap: 50 annotations). Run the failing check locally._",
      "parser - parse header ... FAILED\nAssertionError: expected header to be valid\nFAILED | 1405 passed | 1 failed (2m31s)",
    ],
    [
      "thread 'tests::parse_header' panicked at src/lib.rs:10: invalid header\ntest result: FAILED. 42 passed; 1 failed",
      "thread 'tests::parse_header' panicked at src/lib.rs:10: invalid header\ntest result: FAILED. 41 passed; 1 failed",
    ],
  ];
  for (const [failureText, baseLog] of cases) {
    const log = logFake(excerptOf(baseLog));
    const result = await compareBaseFailure({
      repo: REPO,
      checkName: CHECK,
      baseCheckRunId: BASE_RUN_ID,
      failureText,
      ghFn: unusedGh,
      actionsLogFn: log.fn,
    });
    assertEquals(result.state, "same");
  }
});

Deno.test("compareBaseFailure - Jest identifies the failing test rather than shared suite output", async () => {
  const generic =
    "FAIL src/sum.test.js\nTests: 1 failed, 5 passed, 6 total\nTest Suites: 1 failed, 1 total\nnpm error path /work/project\nnpm error command sh -c jest";
  const log = logFake(excerptOf(`${generic}\n  ● subtracts 5 - 2 to equal 3`));
  const result = await compareBaseFailure({
    repo: REPO,
    checkName: CHECK,
    baseCheckRunId: BASE_RUN_ID,
    failureText: `${generic}\n  ● adds 1 + 2 to equal 3`,
    ghFn: unusedGh,
    actionsLogFn: log.fn,
  });
  assertEquals(result.state, "different");
  assertEquals(failureSignatureLines(generic), []);
});

Deno.test("compareBaseFailure - notices and variable runner output do not obscure the same failure", async () => {
  const pr =
    "- **runner:1**: The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026.\nparser - header ... FAILED (150µs)\nAssertionError: invalid header value\nFAILED | 8693 passed (4 steps) | 1 failed (6m11s)\n=== 1 failed, 41 passed in 2.3s ===\nTests  1 failed | 5 passed (6)";
  const base =
    "parser - header ... FAILED (171µs)\nAssertionError: invalid header value\nFAILED | 8690 passed (4 steps) | 1 failed (6m29s)\n=== 1 failed, 40 passed in 3.4s ===\nTests  1 failed | 4 passed (5)";
  const result = await compareBaseFailure({
    repo: REPO,
    checkName: CHECK,
    baseCheckRunId: BASE_RUN_ID,
    failureText: pr,
    ghFn: unusedGh,
    actionsLogFn: logFake(excerptOf(base)).fn,
  });
  assertEquals(result.state, "same");
});

Deno.test("compareBaseFailure - node and bats test names distinguish unrelated failures", async () => {
  const cases: [string, string][] = [
    [
      "✖ adds 1 + 2\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
      "✖ subtracts 5 - 2\nAssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
    ],
    [
      "not ok 3 parser rejects a bad header\n# command failed",
      "not ok 3 renderer pads the title\n# command failed",
    ],
  ];
  for (const [pr, base] of cases) {
    const result = await compareBaseFailure({
      repo: REPO,
      checkName: CHECK,
      baseCheckRunId: BASE_RUN_ID,
      failureText: pr,
      ghFn: unusedGh,
      actionsLogFn: logFake(excerptOf(base)).fn,
    });
    assertEquals(result.state, "different");
  }
});

Deno.test("compareBaseFailure - TAP numbers change without changing the failure", async () => {
  for (
    const [pr, base] of [
      [
        "not ok 4 parser rejects a bad header\n# command failed",
        "not ok 3 parser rejects a bad header\n# command failed",
      ],
      [
        "not ok 5 - adds 1 + 2\nAssertionError: expected 3",
        "not ok 4 - adds 1 + 2\nAssertionError: expected 3",
      ],
    ] as [string, string][]
  ) {
    const result = await compareBaseFailure({
      repo: REPO,
      checkName: CHECK,
      baseCheckRunId: BASE_RUN_ID,
      failureText: pr,
      ghFn: unusedGh,
      actionsLogFn: logFake(excerptOf(base)).fn,
    });
    assertEquals(result.state, "same");
  }
});

Deno.test("compareBaseFailure - Vitest file tallies do not obscure the same failure", async () => {
  const failure =
    "FAIL src/sum.test.ts > sum > adds\nAssertionError: expected 3 to be 4";
  const result = await compareBaseFailure({
    repo: REPO,
    checkName: CHECK,
    baseCheckRunId: BASE_RUN_ID,
    failureText: `${failure}\nTest Files  1 failed | 6 passed (7)`,
    ghFn: unusedGh,
    actionsLogFn:
      logFake(excerptOf(`${failure}\nTest Files  1 failed | 5 passed (6)`)).fn,
  });
  assertEquals(result.state, "same");
});

Deno.test("compareBaseFailure - Mocha names distinguish failures and ignore sequence numbers", async () => {
  const error =
    "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:";
  for (
    const [base, expected] of [[`2) adds 1 + 2\n${error}`, "same"], [
      `1) subtracts 5 - 2\n${error}`,
      "different",
    ]] as [string, string][]
  ) {
    const result = await compareBaseFailure({
      repo: REPO,
      checkName: CHECK,
      baseCheckRunId: BASE_RUN_ID,
      failureText: `1) adds 1 + 2\n${error}`,
      ghFn: unusedGh,
      actionsLogFn: logFake(excerptOf(base)).fn,
    });
    assertEquals(result.state, expected);
  }
});

const REPO = "org/repo";
const CHECK = "Project Validation";
const BASE_RUN_ID = 9001;
const ESC = String.fromCharCode(0x1b);

/** A `gh` runner that must never be reached: the log fetcher is faked. */
function unusedGh(): Promise<string> {
  return Promise.reject(new Error("gh must not be called in this test"));
}

/**
 * A fake log fetcher that answers once with `answer` (or rejects with it) and
 * records each call, so a test can prove whether the log was fetched at all.
 */
function logFake(answer: ActionsLogOutcome | Error) {
  const calls: ActionsLogOptions[] = [];
  const fn = (opts: ActionsLogOptions): Promise<ActionsLogOutcome> => {
    calls.push(opts);
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  };
  return { fn, calls };
}

/** A successful base-run log excerpt answer. */
function excerptOf(excerpt: string): ActionsLogOutcome {
  return {
    kind: "excerpt",
    providerId: "github-actions",
    jobId: 1,
    excerpt,
  };
}

/** The reason of an `unreadable` result, failing the test on any other state. */
function unreadableReason(result: BaseFailureComparison): string {
  if (result.state !== "unreadable") {
    throw new Error(`expected unreadable, got ${result.state}`);
  }
  return result.reason;
}

Deno.test("compareBaseFailure - the same failure across timestamps, run numbers and ANSI is same", async () => {
  const failureText =
    `${ESC}[31m2026-11-01T10:00:00.1234567Z ##[error]Build #41 failed: expected 3 to equal 4 after 12s${ESC}[0m\n`;
  const baseLog =
    `${ESC}[33m2026-11-02T23:59:59.9Z${ESC}[0m Starting run 97\n` +
    `2026-11-02T23:59:59.9Z ##[error]Build #97 failed: expected 3 to equal 4 after 15s\n`;
  const log = logFake(excerptOf(baseLog));

  const result = await compareBaseFailure({
    repo: REPO,
    checkName: CHECK,
    baseCheckRunId: BASE_RUN_ID,
    failureText,
    ghFn: unusedGh,
    actionsLogFn: log.fn as typeof fetchGithubActionsLogExcerpt,
  });

  assertEquals(result.state, "same");
  if (result.state === "same") {
    assertStringIncludes(result.matched, "build <n> failed: expected 3");
  }
  assertEquals(log.calls.length, 1);
  assertEquals(log.calls[0]?.checkRunId, String(BASE_RUN_ID));
  assertEquals(log.calls[0]?.checkName, CHECK);
  assertEquals(log.calls[0]?.repo, REPO);
});

Deno.test("compareBaseFailure - a different error text in the base log is different", async () => {
  const failureText =
    "src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\n";
  const baseLog =
    "2026-11-02T10:00:00Z src/bar.ts(3,1): error TS2304: Cannot find name 'widget'.\n";
  const log = logFake(excerptOf(baseLog));

  const result = await compareBaseFailure({
    repo: REPO,
    checkName: CHECK,
    baseCheckRunId: BASE_RUN_ID,
    failureText,
    ghFn: unusedGh,
    actionsLogFn: log.fn as typeof fetchGithubActionsLogExcerpt,
  });

  assertEquals(result, { state: "different" });
  assertEquals(log.calls.length, 1);
});

Deno.test("compareBaseFailure - a shared generic exit line alone is different", async () => {
  // The PR carries two real failure lines and the runner's exit line. Only the
  // exit line appears in the base log, so it must not count as evidence.
  const failureText =
    "src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable.\n" +
    "src/foo.ts(12,5): error TS2322: Type 'boolean' is not assignable to type 'string'.\n" +
    "Error: Process completed with exit code 1.\n";
  const baseLog = "2026-11-02T10:00:00Z Lint passed for every package\n" +
    "2026-11-02T10:00:01Z Error: Process completed with exit code 1.\n";
  const log = logFake(excerptOf(baseLog));

  const result = await compareBaseFailure({
    repo: REPO,
    checkName: CHECK,
    baseCheckRunId: BASE_RUN_ID,
    failureText,
    ghFn: unusedGh,
    actionsLogFn: log.fn as typeof fetchGithubActionsLogExcerpt,
  });

  assertEquals(result, { state: "different" });
});

Deno.test("compareBaseFailure - an annotation with a failure word matches its message in the base log", async () => {
  const failureText = "- **a/b.ts:4**: semgrep error: rule fired - x\n";
  const baseLog =
    "2026-11-02T10:00:00Z ##[error]semgrep error: rule fired - x\n";
  const log = logFake(excerptOf(baseLog));

  const result = await compareBaseFailure({
    repo: REPO,
    checkName: CHECK,
    baseCheckRunId: BASE_RUN_ID,
    failureText,
    ghFn: unusedGh,
    actionsLogFn: log.fn as typeof fetchGithubActionsLogExcerpt,
  });

  assertEquals(result, {
    state: "same",
    matched: "semgrep error: rule fired - x",
  });
});

Deno.test("compareBaseFailure - empty or boilerplate failure text is unreadable and never fetches the log", async () => {
  const texts = [
    "",
    "   \n\n  \t\n",
    "No specific annotations were available. Please check the CI logs and run the failing check locally to identify the issue.\n",
  ];

  for (const failureText of texts) {
    const log = logFake(excerptOf("2026-11-02T10:00:00Z ##[error]anything\n"));

    const result = await compareBaseFailure({
      repo: REPO,
      checkName: CHECK,
      baseCheckRunId: BASE_RUN_ID,
      failureText,
      ghFn: unusedGh,
      actionsLogFn: log.fn as typeof fetchGithubActionsLogExcerpt,
    });

    assertStringIncludes(
      unreadableReason(result),
      "carried no line that could be compared",
    );
    assertEquals(log.calls.length, 0);
  }
});

Deno.test("compareBaseFailure - the details header alone is unreadable and never fetches the log", async () => {
  const failureText = "The following CI failure details were detected:\n\n";
  const log = logFake(excerptOf("2026-11-02T10:00:00Z ##[error]anything\n"));

  const result = await compareBaseFailure({
    repo: REPO,
    checkName: CHECK,
    baseCheckRunId: BASE_RUN_ID,
    failureText,
    ghFn: unusedGh,
    actionsLogFn: log.fn as typeof fetchGithubActionsLogExcerpt,
  });

  assertStringIncludes(
    unreadableReason(result),
    "carried no line that could be compared",
  );
  assertEquals(log.calls.length, 0);
});

Deno.test("compareBaseFailure - a base excerpt that normalises to empty is unreadable, not different", async () => {
  const failureText =
    "src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable.\n";
  const emptyExcerpts = ["", `${ESC}[0m   \n\t\n`];

  for (const excerpt of emptyExcerpts) {
    const log = logFake(excerptOf(excerpt));

    const result = await compareBaseFailure({
      repo: REPO,
      checkName: CHECK,
      baseCheckRunId: BASE_RUN_ID,
      failureText,
      ghFn: unusedGh,
      actionsLogFn: log.fn as typeof fetchGithubActionsLogExcerpt,
    });

    assertStringIncludes(
      unreadableReason(result),
      "the base run's log was empty",
    );
    assertEquals(log.calls.length, 1);
  }
});

Deno.test("compareBaseFailure - an error outcome from the log fetcher is unreadable with its cause", async () => {
  const failureText =
    "src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable.\n";
  const log = logFake({ kind: "error", error: "HTTP 502 from actions logs" });

  const result = await compareBaseFailure({
    repo: REPO,
    checkName: CHECK,
    baseCheckRunId: BASE_RUN_ID,
    failureText,
    ghFn: unusedGh,
    actionsLogFn: log.fn as typeof fetchGithubActionsLogExcerpt,
  });

  assertStringIncludes(
    unreadableReason(result),
    "HTTP 502 from actions logs",
  );
});

Deno.test("compareBaseFailure - a not-applicable outcome from the log fetcher is unreadable with its reason", async () => {
  const failureText =
    "src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable.\n";
  const log = logFake({
    kind: "not-applicable",
    reason: "check run has no GitHub Actions job",
  });

  const result = await compareBaseFailure({
    repo: REPO,
    checkName: CHECK,
    baseCheckRunId: BASE_RUN_ID,
    failureText,
    ghFn: unusedGh,
    actionsLogFn: log.fn as typeof fetchGithubActionsLogExcerpt,
  });

  assertStringIncludes(
    unreadableReason(result),
    "check run has no GitHub Actions job",
  );
});

Deno.test("compareBaseFailure - a throwing log fetcher is unreadable with the error message", async () => {
  const failureText =
    "src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable.\n";
  const log = logFake(new Error("socket hang up"));

  const result = await compareBaseFailure({
    repo: REPO,
    checkName: CHECK,
    baseCheckRunId: BASE_RUN_ID,
    failureText,
    ghFn: unusedGh,
    actionsLogFn: log.fn as typeof fetchGithubActionsLogExcerpt,
  });

  assertEquals(
    unreadableReason(result),
    "the base run's log could not be read: socket hang up",
  );
});

Deno.test("compareBaseFailure - a log fetcher rejecting with a non-Error value is unreadable with that value as text", async () => {
  const failureText =
    "src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable.\n";
  const fn = (): Promise<ActionsLogOutcome> => Promise.reject("rate limited");

  const result = await compareBaseFailure({
    repo: REPO,
    checkName: CHECK,
    baseCheckRunId: BASE_RUN_ID,
    failureText,
    ghFn: unusedGh,
    actionsLogFn: fn as unknown as typeof fetchGithubActionsLogExcerpt,
  });

  assertEquals(
    unreadableReason(result),
    "the base run's log could not be read: rate limited",
  );
});

Deno.test("compareBaseFailure - the caller's gh runner is handed to the log fetcher", async () => {
  const failureText =
    "src/foo.ts(10,5): error TS2345: Argument of type 'string' is not assignable.\n";
  const log = logFake(excerptOf("nothing relevant here at all, just noise\n"));

  await compareBaseFailure({
    repo: REPO,
    checkName: CHECK,
    baseCheckRunId: BASE_RUN_ID,
    failureText,
    ghFn: unusedGh,
    actionsLogFn: log.fn as typeof fetchGithubActionsLogExcerpt,
  });

  assertEquals(log.calls[0]?.ghFn, unusedGh);
});

Deno.test("compareBaseFailure - logs sharing only a command-echo line but with different errors are different", async () => {
  const echo = "##[group]Run cargo test --workspace --no-fail-fast";
  const failureText = `${echo}\n` +
    "2026-11-01T10:00:00Z ##[error]thread 'a' panicked at src/a.rs:3: boom\n";
  const baseLog = `2026-11-02T10:00:00Z ${echo}\n` +
    "2026-11-02T10:00:01Z ##[command]curl --fail https://example.test/setup.sh\n" +
    "2026-11-02T10:00:02Z ##[error]linker `cc` not found while building b\n";
  const log = logFake(excerptOf(baseLog));

  const result = await compareBaseFailure({
    repo: REPO,
    checkName: CHECK,
    baseCheckRunId: BASE_RUN_ID,
    failureText,
    ghFn: unusedGh,
    actionsLogFn: log.fn as typeof fetchGithubActionsLogExcerpt,
  });

  assertEquals(result, { state: "different" });
});

Deno.test("failureSignatureLines - command echoes and flag-only failure words are not failure lines", () => {
  const lines = failureSignatureLines(
    [
      "##[group]Run cargo test --workspace --no-fail-fast",
      "2026-11-01T10:00:00Z ##[group]Run curl --fail https://example.test/x.sh",
      "Run curl --fail https://example.test/x.sh",
      "[command]/usr/bin/git fetch --no-fail-fast origin",
      "##[endgroup]",
      "##[error]assertion failed: left == right in widget_test",
    ].join("\n"),
  );
  assertEquals(lines, ["assertion failed: left == right in widget_test"]);
});

Deno.test("failureSignatureLines - a repeated failure line is listed once", () => {
  const line = "##[error]assertion failed: left == right in widget_test";
  const lines = failureSignatureLines(`${line}\n${line}\n${line}\n`);
  assertEquals(lines, ["assertion failed: left == right in widget_test"]);
});

Deno.test("failureSignatureLines - hostile repeated failure words stay bounded", () => {
  const lines = failureSignatureLines("error ".repeat(100000));
  assertEquals(Array.isArray(lines), true);
  assertEquals(lines.length, 1);
});

Deno.test("failureSignatureLines - hostile whitespace is bounded and yields no line", () => {
  const lines = failureSignatureLines(" ".repeat(200000) + "x");
  assertEquals(Array.isArray(lines), true);
  assertEquals(lines.length, 0);
});

Deno.test("failureSignatureLines - a hostile unclosed annotation prefix is bounded and yields no line", () => {
  const lines = failureSignatureLines("- **" + "a".repeat(100000));
  assertEquals(Array.isArray(lines), true);
  assertEquals(lines.length, 0);
});

Deno.test("compareBaseFailure - unrelated cargo and Deno failures do not match shared runner output", async () => {
  const cases: [string, string][] = [
    [
      "thread 'tests::parse_header' panicked at src/lib.rs:10:\nassertion `left == right` failed\nerror: test failed, to rerun pass `-p crate --lib`",
      "thread 'tests::render_footer' panicked at src/lib.rs:20:\nassertion `left == right` failed\nerror: test failed, to rerun pass `-p crate --lib`",
    ],
    [
      "parser - rejects an unterminated string with an error ... ok (2ms)\nparser - parse header ... FAILED\nnpm error command failed",
      "parser - rejects an unterminated string with an error ... ok (3ms)\nparser - render footer ... FAILED\nnpm error command failed",
    ],
    [
      "error: shared setup problem with a specific detail\nerror: parse header failed",
      "error: shared setup problem with a specific detail\nerror: render footer failed",
    ],
  ];
  for (const [failureText, baseLog] of cases) {
    const log = logFake(excerptOf(baseLog));
    const result = await compareBaseFailure({
      repo: REPO,
      checkName: CHECK,
      baseCheckRunId: BASE_RUN_ID,
      failureText,
      ghFn: unusedGh,
      actionsLogFn: log.fn as typeof fetchGithubActionsLogExcerpt,
    });
    assertEquals(result, { state: "different" });
  }
});

Deno.test("failureSignatureLines - generic runner output alone is unreadable", () => {
  assertEquals(
    failureSignatureLines(
      [
        "assertion `left == right` failed",
        "assertion `left != right` failed",
        "error: test failed, to rerun pass `-p crate --lib`",
        "npm error command failed",
        "npm error Lifecycle script test failed",
        "parser - rejects an error ... ok (2ms)",
      ].join("\n"),
    ),
    [],
  );
});
