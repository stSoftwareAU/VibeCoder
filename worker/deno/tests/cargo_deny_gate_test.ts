/**
 * Tests for the cargo-deny CI gate (Issue #4626).
 *
 * No network and no real cargo: the runner is injected and the workflow
 * findings are injected or parsed from fixture text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type CargoDenyCiFinding,
  cargoDenyTriggered,
  classifyCargoDenyFailure,
  repoCargoDenyFindings,
  runCargoDenyGate,
  workflowCargoDenyFindings,
} from "../lib/cargo_deny_gate.ts";
import {
  type PreFlightCommandResult,
  type PreFlightFailureReason,
  PreFlightGateError,
  type PreFlightRunner,
} from "../lib/pre_flight_gate.ts";

const DENY_CHECK_ARGV = [
  "cargo",
  "deny",
  "--all-features",
  "check",
  "advisories",
  "bans",
];

/** Join workflow fixture lines, so the indentation each test relies on is visible. */
function yaml(...lines: string[]): string {
  return lines.join("\n");
}

/** A runner that records each call and answers with `outcome(command)`. */
function fakeRunner(
  outcome: (command: string) => Partial<PreFlightCommandResult>,
): {
  runner: PreFlightRunner;
  calls: { command: string; cwd: string | undefined }[];
} {
  const calls: { command: string; cwd: string | undefined }[] = [];
  const runner: PreFlightRunner = (command, options) => {
    calls.push({ command, cwd: options.cwd });
    return Promise.resolve({
      started: true,
      code: 0,
      stdout: "",
      stderr: "",
      ...outcome(command),
    });
  };
  return { runner, calls };
}

function gateError(
  reason: PreFlightFailureReason,
  output: string,
): PreFlightGateError {
  return new PreFlightGateError({
    reason,
    command: "cargo deny check",
    exitCode: reason === "non-zero-exit" ? 1 : -1,
    output,
    message: `Pre-flight gate BLOCK: command failed.\n\n${output}`,
  });
}

const REAL_ADVISORY_OUTPUT = [
  "2026-11-07 18:04:31 [ERROR] failed to fetch advisory database " +
  "https://invalid.invalid/x with cli: failed to clone: [...]",
  "fatal: unable to access 'https://invalid.invalid/x/': CONNECT tunnel " +
  "failed, response 403",
].join("\n");

// ---------------------------------------------------------------------------
// workflowCargoDenyFindings
// ---------------------------------------------------------------------------

Deno.test("workflow: a single-line run command is found", () => {
  const text = yaml(
    "jobs:",
    "  deny:",
    "    steps:",
    "      - name: deny",
    "        run: cargo deny --all-features check advisories bans",
  );
  assertEquals(workflowCargoDenyFindings(text), [
    { kind: "command", argv: DENY_CHECK_ARGV, cwd: "." },
  ]);
});

Deno.test("workflow: a literal block scalar with the command on the next line is found", () => {
  const text = yaml(
    "      - name: deny",
    "        run: |",
    "          cargo deny --all-features check advisories bans",
  );
  assertEquals(workflowCargoDenyFindings(text), [
    { kind: "command", argv: DENY_CHECK_ARGV, cwd: "." },
  ]);
});

Deno.test("workflow: a folded block scalar with chomping indicator is found", () => {
  const text = yaml(
    "      - name: deny",
    "        run: >-",
    "          cargo deny --all-features check advisories bans",
  );
  assertEquals(workflowCargoDenyFindings(text), [
    { kind: "command", argv: DENY_CHECK_ARGV, cwd: "." },
  ]);
});

Deno.test("workflow: a backslash-continued line is joined into one command", () => {
  const text = yaml(
    "      - name: deny",
    "        run: |",
    "          cargo deny \\",
    "            --all-features check advisories bans",
  );
  assertEquals(workflowCargoDenyFindings(text), [
    { kind: "command", argv: DENY_CHECK_ARGV, cwd: "." },
  ]);
});

Deno.test("workflow: a plain multi-line run value is folded into one command", () => {
  const text = yaml(
    "      - name: deny",
    "        run: cargo deny --all-features",
    "          check advisories bans",
  );
  assertEquals(workflowCargoDenyFindings(text), [
    { kind: "command", argv: DENY_CHECK_ARGV, cwd: "." },
  ]);
});

Deno.test("workflow: a quoted inline run value is still seen", () => {
  const text = yaml(
    '      - run: "cargo deny check"',
  );
  assertEquals(workflowCargoDenyFindings(text), [
    { kind: "command", argv: ["cargo", "deny", "check"], cwd: "." },
  ]);
});

Deno.test("workflow: the command is cut at the first unquoted shell operator", () => {
  const text = yaml(
    "      - run: cargo deny check 2>&1 | tee deny.log",
    "      - run: cargo deny check && echo ok",
    "      - run: cargo deny check # a note",
  );
  assertEquals(workflowCargoDenyFindings(text), [
    { kind: "command", argv: ["cargo", "deny", "check"], cwd: "." },
    { kind: "command", argv: ["cargo", "deny", "check"], cwd: "." },
    { kind: "command", argv: ["cargo", "deny", "check"], cwd: "." },
  ]);
});

Deno.test("workflow: working-directory sets the command's cwd", () => {
  const text = yaml(
    "      - name: deny",
    "        working-directory: crates/app",
    "        run: cargo deny check bans",
  );
  assertEquals(workflowCargoDenyFindings(text), [
    {
      kind: "command",
      argv: ["cargo", "deny", "check", "bans"],
      cwd: "crates/app",
    },
  ]);
});

Deno.test("workflow: a working-directory with '..' is unrunnable", () => {
  const text = yaml(
    "      - name: deny",
    "        working-directory: ../other",
    "        run: cargo deny check bans",
  );
  const findings = workflowCargoDenyFindings(text);
  assertEquals(findings.length, 1);
  const [finding] = findings;
  assert(finding?.kind === "unrunnable");
  assertStringIncludes(finding.reason, "not a plain relative path");
});

Deno.test("workflow: the cargo-deny-action with defaults builds CI's argv from the root", () => {
  const text = yaml(
    "      - uses: EmbarkStudios/cargo-deny-action@v2",
  );
  assertEquals(workflowCargoDenyFindings(text), [
    {
      kind: "command",
      argv: [
        "cargo",
        "deny",
        "--log-level",
        "warn",
        "--manifest-path",
        "./Cargo.toml",
        "--all-features",
        "check",
      ],
      cwd: ".",
    },
  ]);
});

Deno.test("workflow: the cargo-deny-action with `with:` overrides uses them", () => {
  const text = yaml(
    '      - uses: "EmbarkStudios/cargo-deny-action@v2.0.0"',
    "        with:",
    "          log-level: info",
    "          manifest-path: 'crates/app/Cargo.toml'",
    "          arguments: --all-features --locked",
    "          command: check",
    "          command-arguments: advisories bans",
  );
  assertEquals(workflowCargoDenyFindings(text), [
    {
      kind: "command",
      argv: [
        "cargo",
        "deny",
        "--log-level",
        "info",
        "--manifest-path",
        "crates/app/Cargo.toml",
        "--all-features",
        "--locked",
        "check",
        "advisories",
        "bans",
      ],
      cwd: ".",
    },
  ]);
});

Deno.test("workflow: look-alikes that are not cargo-deny check runs are not findings", () => {
  const text = yaml(
    "      - run: cargo install cargo-deny --locked",
    '      - run: echo "cargo deny check"',
    "      - run: cargo deny list",
    "      - run: cargo deny init",
    "      # - run: cargo deny check",
    "      - run: |",
    "          # cargo deny check",
    "          cargo deny fetch",
  );
  assertEquals(workflowCargoDenyFindings(text), []);
});

Deno.test("workflow: a shell variable in a cargo deny check line is unrunnable", () => {
  const text = yaml("      - run: cargo deny $DENY_FLAGS check bans");
  const findings = workflowCargoDenyFindings(text);
  assertEquals(findings.length, 1);
  const [finding] = findings;
  assert(finding?.kind === "unrunnable");
  assertEquals(finding.source, "line 1");
  assertStringIncludes(finding.reason, "shell variable or workflow expression");
});

Deno.test("workflow: a workflow expression in a cargo deny check line is unrunnable", () => {
  const text = yaml(
    "      - run: cargo deny ${{ matrix.args }} check bans",
  );
  const findings = workflowCargoDenyFindings(text);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]?.kind, "unrunnable");
});

Deno.test("workflow: a workflow expression in an action input is unrunnable", () => {
  const text = yaml(
    "      - uses: EmbarkStudios/cargo-deny-action@v2",
    "        with:",
    "          manifest-path: ${{ matrix.manifest }}",
  );
  const findings = workflowCargoDenyFindings(text);
  assertEquals(findings.length, 1);
  assertEquals(findings[0]?.kind, "unrunnable");
});

Deno.test("workflow: a cargo deny check after && or || is found", () => {
  const text = yaml(
    "      - run: cargo fetch && cargo deny check",
    "      - run: cargo deny check || true",
  );
  assertEquals(workflowCargoDenyFindings(text), [
    { kind: "command", argv: ["cargo", "deny", "check"], cwd: "." },
    { kind: "command", argv: ["cargo", "deny", "check"], cwd: "." },
  ]);
});

Deno.test("workflow: a cargo deny check after env assignments is found", () => {
  const text = yaml(
    "      - run: CARGO_TERM_COLOR=always cargo deny --all-features check",
    "      - run: RUST_LOG=\"warn x\" FOO='a && b' cargo deny check bans",
  );
  assertEquals(workflowCargoDenyFindings(text), [
    {
      kind: "command",
      argv: ["cargo", "deny", "--all-features", "check"],
      cwd: ".",
    },
    { kind: "command", argv: ["cargo", "deny", "check", "bans"], cwd: "." },
  ]);
});

Deno.test("workflow: a cd segment is ignored and does not change the cwd", () => {
  const text = yaml("      - run: cd x; cargo deny check");
  assertEquals(workflowCargoDenyFindings(text), [
    { kind: "command", argv: ["cargo", "deny", "check"], cwd: "." },
  ]);
});

Deno.test("workflow: operator segments that are not cargo deny check runs are not findings", () => {
  const text = yaml(
    "      - run: echo cargo deny check && echo ok",
    "      - run: CARGO_TERM_COLOR=always cargo install cargo-deny",
    "      - run: cd x; cargo deny list",
    "      - run: cargo deny list && cargo deny fetch",
    '      - run: echo "cargo deny check && x"',
    "      - run: FOO=bar",
  );
  assertEquals(workflowCargoDenyFindings(text), []);
});

Deno.test("workflow: a cargo deny segment with a shell variable is unrunnable even without check", () => {
  const lines = [
    "      - run: cargo deny ${{ matrix.cmd }}",
    "      - run: cargo deny $CMD",
    "      - run: cargo fetch && cargo deny $CMD",
    "      - run: CARGO_TERM_COLOR=${{ matrix.color }} cargo deny check",
  ];
  for (const line of lines) {
    const findings = workflowCargoDenyFindings(yaml(line));
    assertEquals(findings.length, 1, line);
    assertEquals(findings[0]?.kind, "unrunnable", line);
  }
});

Deno.test("workflow: a 200000-character line returns promptly", () => {
  const long = "a".repeat(200_000) + "!";
  const findings = workflowCargoDenyFindings(
    yaml("      - run: cargo deny check " + long),
  );
  assertEquals(findings.length, 1);
  assertEquals(findings[0]?.kind, "command");

  const keyless = workflowCargoDenyFindings(
    yaml("      - " + long),
  );
  assertEquals(keyless, []);
});

// ---------------------------------------------------------------------------
// repoCargoDenyFindings
// ---------------------------------------------------------------------------

Deno.test("repo: an unreadable workflow is one unrunnable finding naming the file", async () => {
  const findings = await repoCargoDenyFindings(
    "/nonexistent-issue-4626-root",
    [".github/workflows/ci.yml", "src/main.rs"],
  );
  assertEquals(findings.length, 1);
  const [finding] = findings;
  assert(finding?.kind === "unrunnable");
  assertEquals(finding.source, ".github/workflows/ci.yml");
});

// ---------------------------------------------------------------------------
// cargoDenyTriggered
// ---------------------------------------------------------------------------

Deno.test("triggered: a source file alone does not trigger", () => {
  assertEquals(cargoDenyTriggered(["src/main.rs"]), false);
});

Deno.test("triggered: a nested Cargo.lock triggers", () => {
  assertEquals(cargoDenyTriggered(["crates/a/Cargo.lock"]), true);
});

Deno.test("triggered: the other cargo inputs trigger", () => {
  assertEquals(cargoDenyTriggered(["Cargo.toml"]), true);
  assertEquals(cargoDenyTriggered(["deny.toml"]), true);
  assertEquals(cargoDenyTriggered(["svc/.deny.toml"]), true);
  assertEquals(cargoDenyTriggered([".cargo/config.toml"]), true);
  assertEquals(cargoDenyTriggered(["x/.cargo/deny.toml"]), true);
});

Deno.test("triggered: look-alike names do not trigger", () => {
  assertEquals(cargoDenyTriggered(["MyCargo.toml"]), false);
  assertEquals(cargoDenyTriggered(["notes/deny.toml.md"]), false);
  assertEquals(cargoDenyTriggered(["xcargo/config.toml"]), false);
});

// ---------------------------------------------------------------------------
// classifyCargoDenyFailure
// ---------------------------------------------------------------------------

Deno.test("classify: the real advisory-database outage is infrastructure, with its cause quoted", () => {
  const result = classifyCargoDenyFailure(
    gateError("non-zero-exit", REAL_ADVISORY_OUTPUT),
  );
  assertEquals(result.kind, "infrastructure");
  assertStringIncludes(
    result.message,
    "failed to fetch advisory database https://invalid.invalid/x with cli",
  );
  assert(
    result.message.startsWith(
      "cargo deny could not run, so the dependency audit was not checked " +
        "(this is not a pass): ",
    ),
  );
});

Deno.test("classify: a bare fatal unable-to-access line is infrastructure", () => {
  const result = classifyCargoDenyFailure(
    gateError(
      "non-zero-exit",
      "fatal: unable to access 'https://invalid.invalid/x/': CONNECT " +
        "tunnel failed, response 403",
    ),
  );
  assertEquals(result.kind, "infrastructure");
  assertStringIncludes(result.message, "fatal: unable to access");
});

Deno.test("classify: a missing cargo-deny subcommand is infrastructure, with its cause quoted", () => {
  const result = classifyCargoDenyFailure(
    gateError("non-zero-exit", "error: no such command: `deny`"),
  );
  assertEquals(result.kind, "infrastructure");
  assertStringIncludes(result.message, "error: no such command: `deny`");
});

Deno.test("classify: a network error with a warning prefix is infrastructure", () => {
  const result = classifyCargoDenyFailure(
    gateError("non-zero-exit", "warning: spurious network error (2/3)"),
  );
  assertEquals(result.kind, "infrastructure");
  assertStringIncludes(result.message, "spurious network error");
});

Deno.test("classify: a verdict line wins over an infrastructure-looking line", () => {
  const output = [
    "error[vulnerability]: Vulnerability found in openssl",
    "2026-11-07 18:04:31 [ERROR] failed to fetch advisory database " +
    "https://invalid.invalid/x",
  ].join("\n");
  const error = gateError("non-zero-exit", output);
  const result = classifyCargoDenyFailure(error);
  assertEquals(result, { kind: "verdict", message: error.message });
});

Deno.test("classify: an infrastructure phrase inside a diagnostic is not at line start, so it is a verdict", () => {
  const output = [
    "  failed to fetch advisory database https://invalid.invalid/x",
    "note: something failed to fetch advisory database in the middle",
  ].join("\n");
  const error = gateError("non-zero-exit", output);
  assertEquals(classifyCargoDenyFailure(error), {
    kind: "verdict",
    message: error.message,
  });
});

Deno.test("classify: an indented advisory line under an error[vulnerability] is a verdict", () => {
  const output = [
    "error[vulnerability]: Vulnerability found in foo",
    "    ├ advisory: failed to fetch advisory database is quoted here",
  ].join("\n");
  const error = gateError("non-zero-exit", output);
  assertEquals(classifyCargoDenyFailure(error).kind, "verdict");
});

Deno.test("classify: an unknown non-zero exit is a verdict", () => {
  const error = gateError("non-zero-exit", "something unexpected happened");
  assertEquals(classifyCargoDenyFailure(error), {
    kind: "verdict",
    message: error.message,
  });
});

Deno.test("classify: a non-zero exit with no output is a verdict", () => {
  const error = gateError("non-zero-exit", "");
  assertEquals(classifyCargoDenyFailure(error).kind, "verdict");
});

Deno.test("classify: a command that could not be started is infrastructure, with its cause quoted", () => {
  const result = classifyCargoDenyFailure(
    gateError("not-started", "No such file or directory (os error 2)"),
  );
  assertEquals(result.kind, "infrastructure");
  assertStringIncludes(
    result.message,
    "No such file or directory (os error 2)",
  );
});

Deno.test("classify: a timed-out command is infrastructure, with its cause quoted", () => {
  const result = classifyCargoDenyFailure(
    gateError("timeout", "timed out after 1800s"),
  );
  assertEquals(result.kind, "infrastructure");
  assertStringIncludes(result.message, "timed out after 1800s");
});

Deno.test("classify: URL credentials are redacted from an infrastructure cause", () => {
  const result = classifyCargoDenyFailure(
    gateError(
      "non-zero-exit",
      "fatal: unable to access 'https://bob:s3cret@host.example/x/': " +
        "CONNECT tunnel failed",
    ),
  );
  assertEquals(result.kind, "infrastructure");
  assertStringIncludes(result.message, "//***@host.example");
  assert(!result.message.includes("s3cret"));
});

Deno.test("classify: a 200000-character line returns promptly", () => {
  const long = "a".repeat(200_000) + "!";
  const infra = classifyCargoDenyFailure(
    gateError("non-zero-exit", "failed to fetch advisory database " + long),
  );
  assertEquals(infra.kind, "infrastructure");
  assert(infra.message.length < 2_500);

  const credentials = classifyCargoDenyFailure(
    gateError(
      "non-zero-exit",
      "failed to fetch advisory database //user:tok@" + long,
    ),
  );
  assertEquals(credentials.kind, "infrastructure");
  assert(!credentials.message.includes("tok@"));

  const verdict = classifyCargoDenyFailure(
    gateError("non-zero-exit", "error[" + long),
  );
  assertEquals(verdict.kind, "verdict");
});

// ---------------------------------------------------------------------------
// runCargoDenyGate
// ---------------------------------------------------------------------------

Deno.test("gate: a change to no cargo input runs nothing", async () => {
  const { runner, calls } = fakeRunner(() => ({}));
  const result = await runCargoDenyGate({
    cwd: "/repo",
    changed: ["src/main.rs"],
    tracked: [],
    runner,
    findings: [{ kind: "command", argv: DENY_CHECK_ARGV, cwd: "." }],
  });
  assertEquals(result, { ok: true, value: { checksRun: [] } });
  assertEquals(calls.length, 0);
});

Deno.test("gate: a triggered change runs CI's exact argv in the repo root", async () => {
  const { runner, calls } = fakeRunner(() => ({}));
  const argv = [
    "cargo",
    "deny",
    "--log-level",
    "warn",
    "--manifest-path",
    "./Cargo.toml",
    "--all-features",
    "check",
  ];
  const expected =
    "'cargo' 'deny' '--log-level' 'warn' '--manifest-path' './Cargo.toml' " +
    "'--all-features' 'check'";
  const result = await runCargoDenyGate({
    cwd: "/repo",
    changed: ["Cargo.lock"],
    tracked: [],
    runner,
    findings: [{ kind: "command", argv, cwd: "." }],
  });
  assertEquals(result, { ok: true, value: { checksRun: [expected] } });
  assertEquals(calls, [{ command: expected, cwd: "/repo" }]);
});

Deno.test("gate: a finding's cwd is joined under the repo root", async () => {
  const { runner, calls } = fakeRunner(() => ({}));
  await runCargoDenyGate({
    cwd: "/repo",
    changed: ["crates/a/Cargo.lock"],
    tracked: [],
    runner,
    findings: [{
      kind: "command",
      argv: ["cargo", "deny", "check", "bans"],
      cwd: "crates/a",
    }],
  });
  assertEquals(calls.map((call) => call.cwd), ["/repo/crates/a"]);
});

Deno.test("gate: identical findings run once", async () => {
  const { runner, calls } = fakeRunner(() => ({}));
  const finding: CargoDenyCiFinding = {
    kind: "command",
    argv: ["cargo", "deny", "check"],
    cwd: ".",
  };
  await runCargoDenyGate({
    cwd: "/repo",
    changed: ["Cargo.toml"],
    tracked: [],
    runner,
    findings: [finding, { ...finding }],
  });
  assertEquals(calls.length, 1);
});

Deno.test("gate: a failure on the second of two findings stops the gate there", async () => {
  const first: CargoDenyCiFinding = {
    kind: "command",
    argv: ["cargo", "deny", "check", "advisories"],
    cwd: ".",
  };
  const second: CargoDenyCiFinding = {
    kind: "command",
    argv: ["cargo", "deny", "check", "bans"],
    cwd: ".",
  };
  const { runner, calls } = fakeRunner((command) =>
    command.includes("'bans'")
      ? { code: 1, stderr: "error[banned]: crate is banned" }
      : {}
  );
  const result = await runCargoDenyGate({
    cwd: "/repo",
    changed: ["Cargo.lock"],
    tracked: [],
    runner,
    findings: [first, second],
  });
  assertEquals(calls.length, 2);
  assert(!result.ok);
  assertEquals(result.error.kind, "verdict");
  assertStringIncludes(result.error.message, "error[banned]: crate is banned");
});

Deno.test("gate: an unrunnable CI invocation is a verdict naming its source", async () => {
  const { runner, calls } = fakeRunner(() => ({}));
  const result = await runCargoDenyGate({
    cwd: "/repo",
    changed: ["Cargo.lock"],
    tracked: [],
    runner,
    findings: [{
      kind: "unrunnable",
      source: ".github/workflows/ci.yml line 12",
      reason: "the line uses a shell variable",
    }],
  });
  assertEquals(calls.length, 0);
  assert(!result.ok);
  assertEquals(result.error.kind, "verdict");
  assertStringIncludes(
    result.error.message,
    ".github/workflows/ci.yml line 12",
  );
  assertStringIncludes(
    result.error.message,
    "not waved through",
  );
});

Deno.test("gate: an unreadable workflow blocks a triggered change (fail closed)", async () => {
  const { runner, calls } = fakeRunner(() => ({}));
  const result = await runCargoDenyGate({
    cwd: "/nonexistent-issue-4626-root",
    changed: ["Cargo.lock"],
    tracked: [".github/workflows/ci.yml"],
    runner,
  });
  assertEquals(calls.length, 0);
  assert(!result.ok);
  assertEquals(result.error.kind, "verdict");
  assertStringIncludes(result.error.message, ".github/workflows/ci.yml");
});
