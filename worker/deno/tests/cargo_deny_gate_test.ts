/**
 * Tests for the cargo-deny CI gate (Issue #4626).
 *
 * No network and no real cargo: the runner is injected and the workflow
 * findings are injected or parsed from fixture text.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.test("workflow: action matrix expands and unknown command checks all", () => {
  const text = `jobs:
  deny:
    strategy:
      matrix:
        checks: [advisories, bans, licenses, sources]
    steps:
      - uses: EmbarkStudios/cargo-deny-action@v2
        with:
          command: check \${{ matrix.checks }}
`;
  const findings = workflowCargoDenyFindings(text);
  assertEquals(
    findings.map((f) => f.kind === "command" ? f.argv.slice(-2) : f.kind),
    [["check", "advisories"], ["check", "bans"], ["check", "licenses"], [
      "check",
      "sources",
    ]],
  );
  const fallback = workflowCargoDenyFindings(
    text.replace("matrix.checks }}", "matrix.unknown }}"),
  );
  assertEquals(
    fallback[0]?.kind === "command" && fallback[0].argv.at(-1),
    "check",
  );
});

Deno.test("workflow: quoted multiline container script is not a host check", () => {
  assertEquals(
    workflowCargoDenyFindings(`jobs:
  build:
    steps:
      - run: |
          docker run image bash -c '
            cd /scratch
            cargo deny check bans
          '
`),
    [],
  );
});

Deno.test("workflow: action matrix expands manifest paths too", () => {
  const text = `jobs:
  deny:
    strategy:
      matrix:
        manifest: [one/Cargo.toml, two/Cargo.toml]
    steps:
      - uses: EmbarkStudios/cargo-deny-action@v2
        with:
          manifest-path: \${{ matrix.manifest }}
`;
  assertEquals(
    workflowCargoDenyFindings(text).map((f) =>
      f.kind === "command" ? f.argv[5] : f.kind
    ),
    ["one/Cargo.toml", "two/Cargo.toml"],
  );
});

Deno.test("repository container workflow does not run its scratch crate on the host", async () => {
  const text = await Deno.readTextFile(
    "../../.github/workflows/container-build.yml",
  );
  const findings = workflowCargoDenyFindings(text);
  assertEquals(findings, []);
  const { runner, calls } = fakeRunner(() => ({}));
  const result = await runCargoDenyGate({
    cwd: ".",
    changed: ["evals/capability_security/accept/rust/Cargo.toml"],
    tracked: [],
    findings,
    runner,
  });
  assert(result.ok);
  assertEquals(calls, []);
});
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

Deno.test("workflow: a multi-word action `command:` is split into separate argv entries", () => {
  const text = yaml(
    "      - uses: EmbarkStudios/cargo-deny-action@v2",
    "        with:",
    "          command: check bans licenses",
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
        "bans",
        "licenses",
      ],
      cwd: ".",
    },
  ]);
});

Deno.test("workflow: a blank line inside an action's `with:` block does not end the step", () => {
  const text = yaml(
    "      - uses: EmbarkStudios/cargo-deny-action@v2",
    "        with:",
    "          command: check",
    "",
    "          command-arguments: bans",
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
        "bans",
      ],
      cwd: ".",
    },
  ]);
});

Deno.test("workflow: a column-zero comment inside an action's `with:` block does not end the step", () => {
  const text = yaml(
    "      - uses: EmbarkStudios/cargo-deny-action@v2",
    "        with:",
    "          command: check",
    "# a note at column zero",
    "          command-arguments: bans",
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
        "bans",
      ],
      cwd: ".",
    },
  ]);
});

Deno.test("workflow: a bare `-` step whose first line is a comment still finds its keys", () => {
  const text = yaml(
    "      -",
    "        # a note",
    "",
    "        run: cargo deny check",
  );
  assertEquals(workflowCargoDenyFindings(text), [
    { kind: "command", argv: ["cargo", "deny", "check"], cwd: "." },
  ]);
});

Deno.test("workflow: quotes are stripped only from a value quoted at both ends", () => {
  const input = (value: string) =>
    workflowCargoDenyFindings(yaml(
      "      - uses: EmbarkStudios/cargo-deny-action@v2",
      "        with:",
      `          log-level: ${value}`,
    ));
  const logLevel = (value: string): string | undefined => {
    const finding = input(value)[0];
    return finding?.kind === "command" ? finding.argv[3] : undefined;
  };
  // A lone quote is not a quoted pair.
  assertEquals(logLevel('"'), '"');
  // Matching first and last characters that are not quotes are kept.
  assertEquals(logLevel("xyx"), "xyx");
  // An opening quote with no closing quote is kept.
  assertEquals(logLevel('"abc'), '"abc');
  assertEquals(logLevel("'abc"), "'abc");
  // Both quote styles are stripped.
  assertEquals(logLevel('"abc"'), "abc");
  assertEquals(logLevel("'abc'"), "abc");
});

Deno.test("workflow: an operator inside a double-quoted argument does not cut the command", () => {
  const findings = workflowCargoDenyFindings(
    yaml('      - run: cargo deny check --config "a&b.toml"'),
  );
  assertEquals(findings.length, 1);
  const finding = findings[0];
  assert(finding?.kind === "command");
  assertStringIncludes(finding.argv.join(" "), "b.toml");
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

Deno.test("workflow: a shell variable or expression before check is dropped, leaving a plain check", () => {
  assertEquals(
    workflowCargoDenyFindings(
      yaml("      - run: cargo deny $DENY_FLAGS check bans"),
    ),
    [{ kind: "command", argv: ["cargo", "deny", "check", "bans"], cwd: "." }],
  );
  assertEquals(
    workflowCargoDenyFindings(
      yaml("      - run: cargo deny ${{ matrix.args }} check bans"),
    ),
    [{ kind: "command", argv: ["cargo", "deny", "check", "bans"], cwd: "." }],
  );
});

Deno.test("workflow: an expression that is an option's value drops the option with it", () => {
  const argvOf = (line: string) =>
    workflowCargoDenyFindings(yaml(`      - run: ${line}`)).map((finding) =>
      finding.kind === "command" ? finding.argv : finding.kind
    );
  // An expression that is not a matrix key, before `check`.
  assertEquals(
    argvOf(
      "cargo deny --manifest-path ${{ github.workspace }}/Cargo.toml check",
    ),
    [["cargo", "deny", "check"]],
  );
  // After `check`: the option must not be left without its value.
  assertEquals(
    argvOf("cargo deny check --config ${{ env.DENY_CONFIG }}"),
    [["cargo", "deny", "check"]],
  );
  assertEquals(argvOf("cargo deny check --config=$DENY_CONFIG bans"), [
    ["cargo", "deny", "check", "bans"],
  ]);
  // A resolved option and a literal flag stay.
  assertEquals(
    argvOf(
      "cargo deny --all-features check --config deny.toml ${{ env.X }} bans",
    ),
    [[
      "cargo",
      "deny",
      "--all-features",
      "check",
      "--config",
      "deny.toml",
      "bans",
    ]],
  );
});

/** The cargo-deny-action README's "Recommended pipeline if using advisories". */
const README_PIPELINE = `name: CI
on: [push, pull_request]
jobs:
  cargo-deny:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        checks:
          - advisories
          - bans licenses sources

    # Prevent sudden announcement of a new advisory from failing ci:
    continue-on-error: \${{ matrix.checks == 'advisories' }}

    steps:
    - uses: actions/checkout@v3
    - uses: EmbarkStudios/cargo-deny-action@v2
      with:
        command: check \${{ matrix.checks }}
`;

/** The check subset each finding runs: the words after `check`. */
function checkSubsets(findings: CargoDenyCiFinding[]): string[] {
  return findings.map((finding) => {
    assert(finding.kind === "command", JSON.stringify(finding));
    return finding.argv.slice(finding.argv.indexOf("check") + 1).join(" ");
  });
}

Deno.test("workflow: the action README's recommended pipeline expands per matrix entry", () => {
  assertEquals(checkSubsets(workflowCargoDenyFindings(README_PIPELINE)), [
    "advisories",
    "bans licenses sources",
  ]);
});

Deno.test("workflow: the README pipeline marks only its advisories leg as allowed to fail", () => {
  const findings = workflowCargoDenyFindings(README_PIPELINE);
  assertEquals(
    findings.map((finding) =>
      finding.kind === "command" ? finding.allowFailure ?? false : finding.kind
    ),
    [true, false],
  );
});

Deno.test("gate: a failed advisories leg is a warning and a failed bans leg is a verdict (README pipeline)", async () => {
  const findings = workflowCargoDenyFindings(
    README_PIPELINE.replace(
      "    strategy:",
      "# TODO: add a msrv leg\n    strategy:",
    ),
  );
  const advisoriesFails = fakeRunner((command) =>
    command.endsWith("'advisories'")
      ? {
        code: 1,
        stderr: "error[vulnerability]: RUSTSEC-2099-0001 (no patched version)",
      }
      : {}
  );
  const allowed = await runCargoDenyGate({
    cwd: "/repo",
    changed: [],
    always: true,
    tracked: [],
    runner: advisoriesFails.runner,
    findings,
  });
  assert(allowed.ok, allowed.ok ? "" : allowed.error.message);
  assertEquals(allowed.value.checksRun.length, 1);
  assertStringIncludes(allowed.value.checksRun[0] ?? "", "'bans'");
  assertEquals(allowed.value.warnings.length, 1);
  assertStringIncludes(allowed.value.warnings[0] ?? "", "continue-on-error");
  assertStringIncludes(allowed.value.warnings[0] ?? "", "RUSTSEC-2099-0001");
  // The advisory leg ran, after the blocking one.
  assertEquals(advisoriesFails.calls.length, 2);
  assertStringIncludes(advisoriesFails.calls[1]?.command ?? "", "'advisories'");

  const bansFails = fakeRunner((command) =>
    command.includes("'bans'")
      ? { code: 1, stderr: "error[banned]: crate `openssl` is banned" }
      : {}
  );
  const blocked = await runCargoDenyGate({
    cwd: "/repo",
    changed: [],
    always: true,
    tracked: [],
    runner: bansFails.runner,
    findings,
  });
  assert(!blocked.ok);
  assertEquals(blocked.error.kind, "verdict");
  assertStringIncludes(blocked.error.message, "banned");
  // The blocking leg stopped the gate before the allowed one ran.
  assertEquals(bansFails.calls.length, 1);
});

Deno.test("gate: an infrastructure failure of an allowed leg is a warning too", async () => {
  const { runner } = fakeRunner(() => ({
    code: 1,
    stderr: "failed to fetch advisory database https://x.invalid/db",
  }));
  const result = await runCargoDenyGate({
    cwd: "/repo",
    changed: [],
    always: true,
    tracked: [],
    runner,
    findings: [{
      kind: "command",
      argv: ["cargo", "deny", "check", "advisories"],
      cwd: ".",
      allowFailure: true,
    }],
  });
  assert(result.ok);
  assertEquals(result.value.checksRun, []);
  assertEquals(result.value.warnings.length, 1);
});

Deno.test("gate: an identical invocation that CI does not allow to fail still blocks", async () => {
  const argv = ["cargo", "deny", "check", "advisories"];
  const { runner } = fakeRunner(() => ({
    code: 1,
    stderr: "error[vulnerability]: RUSTSEC-2099-0001",
  }));
  for (
    const findings of [
      [{ kind: "command", argv, cwd: ".", allowFailure: true }, {
        kind: "command",
        argv,
        cwd: ".",
      }],
      [{ kind: "command", argv, cwd: "." }, {
        kind: "command",
        argv,
        cwd: ".",
        allowFailure: true,
      }],
    ] as CargoDenyCiFinding[][]
  ) {
    const result = await runCargoDenyGate({
      cwd: "/repo",
      changed: [],
      always: true,
      tracked: [],
      runner,
      findings,
    });
    assert(!result.ok);
  }
});

Deno.test("workflow: continue-on-error is read at step and job level, literally or per matrix entry", () => {
  const allowed = (text: string) =>
    workflowCargoDenyFindings(text).map((finding) =>
      finding.kind === "command" ? finding.allowFailure === true : finding.kind
    );
  // A literal true on the step, on the job, and the job-level false.
  assertEquals(
    allowed(yaml(
      "jobs:",
      "  deny:",
      "    steps:",
      "      - run: cargo deny check",
      "        continue-on-error: true",
    )),
    [true],
  );
  assertEquals(
    allowed(yaml(
      "jobs:",
      "  deny:",
      "    continue-on-error: true",
      "    steps:",
      "      - run: cargo deny check",
    )),
    [true],
  );
  assertEquals(
    allowed(yaml(
      "jobs:",
      "  deny:",
      "    continue-on-error: false",
      "    steps:",
      "      - run: cargo deny check",
      "        continue-on-error: ${{ github.event_name == 'push' }}",
    )),
    [false],
  );
  // A matrix test: `==`, `!=`, a bare key, and a key only some entries set.
  const matrixJob = (test: string) =>
    yaml(
      "jobs:",
      "  deny:",
      `    continue-on-error: ${test}`,
      "    strategy:",
      "      matrix:",
      "        checks: [advisories, bans]",
      "    steps:",
      "      - run: cargo deny check ${{ matrix.checks }}",
    );
  assertEquals(
    allowed(matrixJob("${{ matrix.checks == 'Advisories' }}")),
    [true, false],
  );
  assertEquals(
    allowed(matrixJob("${{ matrix.checks != 'advisories' }}")),
    [false, true],
  );
  assertEquals(allowed(matrixJob("${{ matrix.checks }}")), [false, false]);
  assertEquals(
    allowed(yaml(
      "jobs:",
      "  deny:",
      "    continue-on-error: ${{ matrix.experimental }}",
      "    strategy:",
      "      matrix:",
      "        checks: [advisories, bans]",
      "        include:",
      "          - checks: advisories",
      "            experimental: true",
      "    steps:",
      "      - run: cargo deny check ${{ matrix.checks }}",
    )),
    [true, false],
  );
  // A test the gate does not read, or one with no matrix to evaluate it on,
  // does not allow a failure.
  assertEquals(
    allowed(matrixJob("${{ contains(matrix.checks, 'adv') }}")),
    [false, false],
  );
  assertEquals(
    allowed(yaml(
      "jobs:",
      "  deny:",
      "    continue-on-error: ${{ matrix.checks == 'advisories' }}",
      "    steps:",
      "      - run: cargo deny check",
    )),
    [false],
  );
});

Deno.test("workflow: an action step's continue-on-error is read too", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "      - uses: EmbarkStudios/cargo-deny-action@v2",
    "        continue-on-error: true",
  ));
  assertEquals(findings.length, 1);
  assert(findings[0]?.kind === "command" && findings[0].allowFailure === true);
});

Deno.test("workflow: a continue-on-error test with a long run of spaces is not allowed (hostile input)", () => {
  // `\s*` before an optional group and before `}}` must not backtrack badly.
  for (const tail of ["x", "}", "== '"]) {
    const findings = workflowCargoDenyFindings(yaml(
      "jobs:",
      "  deny:",
      "    strategy:",
      "      matrix:",
      "        checks: [advisories]",
      "    steps:",
      "      - run: cargo deny check",
      "        continue-on-error: ${{ matrix.checks" + " ".repeat(50_000) +
        tail,
    ));
    assertEquals(
      findings.map((finding) =>
        finding.kind === "command" ? finding.allowFailure === true : "other"
      ),
      [false],
    );
  }
});

Deno.test("workflow: a job's defaults.run.working-directory is the cwd of its run steps", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    defaults:",
    "      run:",
    "        working-directory: rust",
    "    steps:",
    "      - run: cargo deny check",
    "      - run: cargo deny check bans",
    "        working-directory: other",
    "      - uses: EmbarkStudios/cargo-deny-action@v2",
  ));
  assertEquals(
    findings.map((finding) =>
      finding.kind === "command" ? finding.cwd : finding.kind
    ),
    ["rust", "other", "."],
  );
});

Deno.test("workflow: a workflow's defaults.run.working-directory applies unless the job sets its own", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "defaults:",
    "  run:",
    "    working-directory: wf",
    "jobs:",
    "  inherits:",
    "    steps:",
    "      - run: cargo deny check",
    "  overrides:",
    "    defaults:",
    "      run:",
    "        working-directory: job",
    "    steps:",
    "      - run: cargo deny check",
    "  also-inherits:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - run: cargo deny check",
  ));
  assertEquals(
    findings.map((finding) =>
      finding.kind === "command" ? finding.cwd : finding.kind
    ),
    ["wf", "job", "wf"],
  );
});

Deno.test("workflow: a default working-directory that cannot be reproduced is unrunnable", () => {
  for (const wd of ["../x", "/abs", "${{ inputs.dir }}"]) {
    const findings = workflowCargoDenyFindings(yaml(
      "jobs:",
      "  deny:",
      "    defaults:",
      "      run:",
      `        working-directory: ${wd}`,
      "    steps:",
      "      - run: cargo deny check",
    ));
    assertEquals(findings.map((finding) => finding.kind), ["unrunnable"], wd);
  }
});

Deno.test("workflow: a working-directory that names a matrix key expands per entry", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    strategy:",
    "      matrix:",
    "        crate: [a, b/c]",
    "    defaults:",
    "      run:",
    "        working-directory: ${{ matrix.crate }}",
    "    steps:",
    "      - run: cargo deny check",
    "      - run: cargo deny check bans",
    "        working-directory: ${{ matrix.crate }}/sub",
  ));
  assertEquals(
    findings.map((finding) =>
      finding.kind === "command"
        ? `${finding.cwd}:${finding.argv.at(-1)}`
        : finding.kind
    ),
    ["a:check", "b/c:check", "a/sub:bans", "b/c/sub:bans"],
  );
});

Deno.test("workflow: a run line's matrix expression expands per matrix entry", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    strategy:",
    "      matrix:",
    "        checks: [advisories, bans]",
    "    steps:",
    "      - run: cargo deny --all-features check ${{ matrix.checks }}",
  ));
  assertEquals(checkSubsets(findings), ["advisories", "bans"]);
  assertEquals(
    findings[0]?.kind === "command" && findings[0].argv.slice(0, 3),
    [
      "cargo",
      "deny",
      "--all-features",
    ],
  );
});

Deno.test("workflow: a run line's matrix expression that cannot be expanded runs a plain check", () => {
  // No matrix, and a matrix value that is not a literal list. The expression
  // is dropped and the literal flag after it stays.
  for (
    const matrix of ["", "      matrix:\n        checks: ${{ fromJSON(x) }}"]
  ) {
    const findings = workflowCargoDenyFindings(
      `jobs:\n  deny:\n    strategy:\n${matrix}\n    steps:\n` +
        "      - run: cargo deny --all-features check ${{ matrix.checks }} --hide-inclusion-graph\n",
    );
    assertEquals(findings, [{
      kind: "command",
      argv: [
        "cargo",
        "deny",
        "--all-features",
        "check",
        "--hide-inclusion-graph",
      ],
      cwd: ".",
    }]);
  }
});

Deno.test("workflow: matrix include entries expand an action's manifest path", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    strategy:",
    "      matrix:",
    "        include:",
    "          - crate: one",
    "          - crate: two",
    "    steps:",
    "      - uses: EmbarkStudios/cargo-deny-action@v2",
    "        with:",
    "          manifest-path: ${{ matrix.crate }}/Cargo.toml",
  ));
  assertEquals(
    findings.map((f) => f.kind === "command" ? f.argv[5] : f.kind),
    ["one/Cargo.toml", "two/Cargo.toml"],
  );
});

Deno.test("workflow: action arguments with spaces and commas expand from the matrix", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    strategy:",
    "      matrix:",
    "        features: ['--all-features', '--features a,b']",
    "    steps:",
    "      - uses: EmbarkStudios/cargo-deny-action@v2",
    "        with:",
    "          arguments: ${{ matrix.features }}",
  ));
  assertEquals(
    findings.map((f) => f.kind === "command" ? f.argv.slice(6) : f.kind),
    [["--all-features", "check"], ["--features", "a,b", "check"]],
  );
});

Deno.test("workflow: an action input that cannot be expanded takes the action's default", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "      - uses: EmbarkStudios/cargo-deny-action@v2",
    "        with:",
    "          manifest-path: ${{ matrix.manifest }}",
    "          arguments: ${{ inputs.flags }}",
    "          command: check ${{ steps.pick.outputs.subset }}",
  ));
  assertEquals(findings, [{
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
  }]);
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

Deno.test("workflow: an environment assignment holding an expression is dropped like any other", () => {
  assertEquals(
    workflowCargoDenyFindings(
      yaml(
        "      - run: CARGO_TERM_COLOR=${{ matrix.color }} cargo deny check",
      ),
    ),
    [{ kind: "command", argv: ["cargo", "deny", "check"], cwd: "." }],
  );
});

Deno.test("workflow: a cargo deny segment with a shell variable is unrunnable even without check", () => {
  const lines = [
    "      - run: cargo deny ${{ matrix.cmd }}",
    "      - run: cargo deny $CMD",
    "      - run: cargo fetch && cargo deny $CMD",
  ];
  for (const line of lines) {
    const findings = workflowCargoDenyFindings(yaml(line));
    assertEquals(findings.length, 1, line);
    assertEquals(findings[0]?.kind, "unrunnable", line);
  }
});

Deno.test("workflow: a run of unterminated expression openers returns a plain check", () => {
  // 50000 `${{ ` openers and no `}}`: each opener must not rescan to the end.
  const findings = workflowCargoDenyFindings(
    yaml("      - run: cargo deny check " + "${{ ".repeat(50_000)),
  );
  assertEquals(findings, [
    { kind: "command", argv: ["cargo", "deny", "check"], cwd: "." },
  ]);
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
  assertEquals(result, { ok: true, value: { checksRun: [], warnings: [] } });
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
  assertEquals(result, {
    ok: true,
    value: { checksRun: [expected], warnings: [] },
  });
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

Deno.test("workflow: an include entry that matches every combination is not also a combination of its own", () => {
  // The entry names no `checks`, so it extends both combinations. A separate
  // combination for it would lack `checks`, and the whole expansion would fall back.
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    strategy:",
    "      matrix:",
    "        checks: [advisories, bans]",
    "        include:",
    "          - experimental: true",
    "    steps:",
    "      - run: cargo deny check ${{ matrix.checks }}",
    "        continue-on-error: ${{ matrix.experimental }}",
  ));
  assertEquals(
    findings.map((f) =>
      f.kind === "command" ? [f.argv.at(-1), f.allowFailure === true] : f.kind
    ),
    [["advisories", true], ["bans", true]],
  );
});

Deno.test("workflow: a matrix key with no value falls back and drops its option", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    strategy:",
    "      matrix:",
    "        other: [a, b]",
    "    steps:",
    "      - run: cargo deny check --config ${{ matrix.missing }}",
  ));
  assertEquals(
    findings.map((f) => f.kind === "command" ? f.argv : f.kind),
    [["cargo", "deny", "check"]],
  );
});

Deno.test("workflow: an unsafe matrix value falls back to a plain check", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    strategy:",
    "      matrix:",
    "        checks: ['bans; echo hi']",
    "    steps:",
    "      - run: cargo deny check ${{ matrix.checks }}",
  ));
  assertEquals(
    findings.map((f) => f.kind === "command" ? f.argv : f.kind),
    [["cargo", "deny", "check"]],
  );
});

Deno.test("workflow: a continue-on-error matrix test is not allowed when the matrix cannot be expanded", () => {
  // `missing` has no value in the matrix, so the command has no combination
  // to evaluate the test on, and the failure blocks.
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    steps:",
    "      - run: cargo deny check ${{ matrix.missing }}",
    "        continue-on-error: ${{ matrix.missing != 'x' }}",
  ));
  assertEquals(
    findings.map((f) =>
      f.kind === "command" ? f.allowFailure === true : f.kind
    ),
    [false],
  );
});

Deno.test("workflow: a dropped expression keeps a preceding option that carries its own value", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    steps:",
    "      - run: cargo deny check --config=deny.toml ${{ env.X }}",
  ));
  assertEquals(
    findings.map((f) => f.kind === "command" ? f.argv : f.kind),
    [["cargo", "deny", "check", "--config=deny.toml"]],
  );
});

Deno.test("workflow: an unrunnable finding names the line it came from", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    steps:",
    "      - run: cargo deny $SUBCOMMAND",
  ));
  assertEquals(findings.length, 1);
  assertEquals(findings[0]?.kind, "unrunnable");
  assertEquals(
    findings[0]?.kind === "unrunnable" && findings[0].source,
    "line 4",
  );
});

Deno.test("workflow: a matrix working directory with no matrix value is unrunnable", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    steps:",
    "      - run: cargo deny check",
    "        working-directory: ${{ matrix.dir }}",
  ));
  assertEquals(findings.map((f) => f.kind), ["unrunnable"]);
});

/** The `[argv.slice(2).join(" "), cwd, allowFailure]` of each finding. */
function summary(findings: CargoDenyCiFinding[]): unknown[] {
  return findings.map((finding) =>
    finding.kind === "command"
      ? [
        finding.argv.slice(2).join(" "),
        finding.cwd,
        finding.allowFailure ?? false,
      ]
      : finding.kind
  );
}

Deno.test("workflow: jobs indented with four spaces keep their defaults and continue-on-error", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "name: ci",
    "on: pull_request",
    "jobs:",
    "    deny:",
    "        defaults:",
    "            run:",
    "                working-directory: rust",
    "        continue-on-error: ${{ matrix.checks == 'advisories' }}",
    "        strategy:",
    "            matrix:",
    "                checks: [advisories, bans]",
    "        steps:",
    "            - run: cargo deny check ${{ matrix.checks }}",
    "    other:",
    "        steps:",
    "            - run: cargo deny check licenses",
  ));
  assertEquals(summary(findings), [
    ["check advisories", "rust", true],
    ["check bans", "rust", false],
    ["check licenses", ".", false],
  ]);
});

Deno.test("workflow: a continue-on-error test on a key the command does not use is evaluated per combination", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    strategy:",
    "      matrix:",
    "        toolchain: [stable, nightly]",
    "    continue-on-error: ${{ matrix.toolchain != 'stable' }}",
    "    steps:",
    "      - run: cargo deny check",
    "      - uses: EmbarkStudios/cargo-deny-action@v2",
    "        continue-on-error: ${{ matrix.toolchain == 'nightly' }}",
  ));
  // The stable leg of the run step blocks, so the merged check blocks.
  assertEquals(
    summary(findings).filter((item) => (item as unknown[])[0] === "check"),
    [["check", ".", false], ["check", ".", true]],
  );
  const action = findings.filter((f) =>
    f.kind === "command" && f.cwd === "." && f.argv.includes("--manifest-path")
  );
  assertEquals(
    action.map((f) => f.kind === "command" && f.allowFailure === true),
    [false, true],
  );
});

Deno.test("gate: a failure on the stable leg of a toolchain-keyed continue-on-error blocks", async () => {
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    strategy:",
    "      matrix:",
    "        toolchain: [stable, nightly]",
    "    continue-on-error: ${{ matrix.toolchain != 'stable' }}",
    "    steps:",
    "      - run: cargo deny check",
  ));
  const failing = fakeRunner(() => ({
    code: 1,
    stderr: "error[vulnerability]: RUSTSEC-2099-0001",
  }));
  const result = await runCargoDenyGate({
    cwd: "/repo",
    changed: [],
    always: true,
    tracked: [],
    runner: failing.runner,
    findings,
  });
  assert(!result.ok);
  assertEquals(result.error.kind, "verdict");
});

Deno.test("workflow: an include on another dimension does not collapse a continue-on-error test", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    strategy:",
    "      matrix:",
    "        os: [ubuntu-latest, windows-latest]",
    "        include:",
    "          - os: windows-latest",
    "            experimental: true",
    "    continue-on-error: ${{ matrix.experimental }}",
    "    steps:",
    "      - run: cargo deny check",
  ));
  // The ubuntu leg blocks and the windows leg is allowed to fail: one check, blocking.
  assertEquals(summary(findings), [
    ["check", ".", false],
    ["check", ".", true],
  ]);
});

Deno.test("workflow: an include on another dimension does not drop a leg that lacks the command key", () => {
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    strategy:",
    "      matrix:",
    "        os: [ubuntu-latest, windows-latest]",
    "        include:",
    "          - os: windows-latest",
    "            checks: advisories",
    "    steps:",
    "      - run: cargo deny check ${{ matrix.checks }}",
  ));
  // The ubuntu leg has no `checks`, so the gate falls back to one plain check.
  assertEquals(summary(findings), [["check", ".", false]]);
});

const SCHEDULE_ONLY = yaml(
  "on:",
  "  schedule:",
  "    - cron: '0 0 * * *'",
  "  workflow_dispatch:",
  "jobs:",
  "  deny:",
  "    steps:",
  "      - run: cargo deny check advisories",
);

const PATH_FILTERED = yaml(
  "on:",
  "  pull_request:",
  "    paths:",
  "      - Cargo.lock",
  "      - Cargo.toml",
  "      - deny.toml",
  "jobs:",
  "  deny:",
  "    steps:",
  "      - run: cargo deny check advisories",
);

Deno.test("workflow: a schedule-only workflow has no findings for a push", () => {
  assertEquals(workflowCargoDenyFindings(SCHEDULE_ONLY), []);
  assertEquals(
    workflowCargoDenyFindings(SCHEDULE_ONLY, { touched: ["Cargo.lock"] }),
    [],
  );
  // Positive control: the same job on a pull_request trigger is found.
  assertEquals(
    summary(workflowCargoDenyFindings(
      SCHEDULE_ONLY.replace("schedule:", "pull_request:").replace(
        "    - cron: '0 0 * * *'\n",
        "",
      ),
    )),
    [["check advisories", ".", false]],
  );
});

Deno.test("workflow: a path-filtered workflow runs only when a touched path matches", () => {
  const sourceOnly = { touched: ["src/main.rs", "README.md"] };
  assertEquals(workflowCargoDenyFindings(PATH_FILTERED, sourceOnly), []);
  assertEquals(
    summary(workflowCargoDenyFindings(PATH_FILTERED, {
      touched: ["src/main.rs", "Cargo.lock"],
    })),
    [["check advisories", ".", false]],
  );
  // Touched paths unknown: the filter cannot rule the workflow out.
  assertEquals(workflowCargoDenyFindings(PATH_FILTERED).length, 1);
});

Deno.test("workflow: paths-ignore and negated paths are read", () => {
  const ignoring = PATH_FILTERED.replace("    paths:", "    paths-ignore:");
  assertEquals(
    workflowCargoDenyFindings(ignoring, { touched: ["Cargo.lock"] }),
    [],
  );
  assertEquals(
    workflowCargoDenyFindings(ignoring, { touched: ["Cargo.lock", "a.rs"] })
      .length,
    1,
  );
  const negated = yaml(
    "on:",
    "  pull_request:",
    "    paths: ['docs/**', '!docs/internal/**', '**/Cargo.lock']",
    "jobs:",
    "  deny:",
    "    steps:",
    "      - run: cargo deny check",
  );
  assertEquals(
    workflowCargoDenyFindings(negated, { touched: ["docs/internal/a.md"] }),
    [],
  );
  assertEquals(
    workflowCargoDenyFindings(negated, { touched: ["docs/a/b.md"] }).length,
    1,
  );
  assertEquals(
    workflowCargoDenyFindings(negated, { touched: ["Cargo.lock"] }).length,
    1,
  );
  assertEquals(
    workflowCargoDenyFindings(negated, { touched: ["crates/x/Cargo.lock"] })
      .length,
    1,
  );
});

Deno.test("workflow: a push trigger runs when its branch filter matches the pushed branch", () => {
  const onMain = yaml(
    "on:",
    "  push:",
    "    branches: [main, 'release/**']",
    "jobs:",
    "  deny:",
    "    steps:",
    "      - run: cargo deny check",
  );
  assertEquals(
    workflowCargoDenyFindings(onMain, { branches: ["issue-1-fix"] }),
    [],
  );
  assertEquals(
    workflowCargoDenyFindings(onMain, { branches: ["release/1.2"] }).length,
    1,
  );
  assertEquals(workflowCargoDenyFindings(onMain, {}).length, 1);
  const ignoring = onMain.replace("branches:", "branches-ignore:");
  assertEquals(
    workflowCargoDenyFindings(ignoring, { branches: ["main"] }),
    [],
  );
  assertEquals(
    workflowCargoDenyFindings(ignoring, { branches: ["issue-1-fix"] }).length,
    1,
  );
  const tagsOnly = yaml(
    "on:",
    "  push:",
    "    tags: ['v*']",
    "jobs:",
    "  deny:",
    "    steps:",
    "      - run: cargo deny check",
  );
  assertEquals(workflowCargoDenyFindings(tagsOnly, {}), []);
  // A pull_request trigger beside the push filter still runs.
  assertEquals(
    workflowCargoDenyFindings(
      onMain.replace("  push:", "  pull_request:\n  push:"),
      { branches: ["issue-1-fix"] },
    ).length,
    1,
  );
});

Deno.test("workflow: trigger forms as a string, a list or merge_group are read", () => {
  const body = [
    "jobs:",
    "  deny:",
    "    steps:",
    "      - run: cargo deny check",
  ];
  for (
    const [on, runs] of [
      ["on: schedule", false],
      ["on: [schedule, workflow_dispatch]", false],
      ["on: workflow_run", false],
      ["on: [schedule, pull_request]", true],
      ["on: pull_request_target", true],
      ["on: merge_group", true],
      ["on: workflow_call", true],
    ] as const
  ) {
    assertEquals(
      workflowCargoDenyFindings(yaml(on, ...body), { touched: ["a.rs"] })
        .length,
      runs ? 1 : 0,
      on,
    );
  }
  // No readable trigger: the workflow is not ruled out.
  assertEquals(workflowCargoDenyFindings(yaml(...body)).length, 1);
});

Deno.test("workflow: a hostile path pattern is not read and does not hang", () => {
  const pattern = "**/".repeat(70) + "x";
  const text = yaml(
    "on:",
    "  pull_request:",
    `    paths: ['${pattern}']`,
    "jobs:",
    "  deny:",
    "    steps:",
    "      - run: cargo deny check",
  );
  // The pattern is unreadable, so the filter selects (the workflow is not ruled out).
  assertEquals(
    workflowCargoDenyFindings(text, { touched: ["a".repeat(2000)] }).length,
    1,
  );
});

Deno.test("workflow: an include list holding a null or a scalar entry is skipped without expanding its characters as keys", () => {
  // `include: ["ab"]` would name the keys "0" and "1" if a scalar entry were read as a mapping,
  // which would expand the unreadable "0" dimension and force the plain-check fallback.
  const findings = workflowCargoDenyFindings(yaml(
    "jobs:",
    "  deny:",
    "    strategy:",
    "      matrix:",
    "        checks: [advisories, bans]",
    "        '0': [[1]]",
    "        include:",
    "          - ~",
    "          - ab",
    "    steps:",
    "      - run: cargo deny check ${{ matrix.checks }}",
  ));
  assertEquals(summary(findings), [
    ["check advisories", ".", false],
    ["check bans", ".", false],
  ]);
});

Deno.test("workflow: column-zero comments preserve matrix and job defaults", () => {
  const pipeline = README_PIPELINE.replace(
    "    strategy:",
    "# TODO: add a msrv leg\n    strategy:",
  );
  const findings = workflowCargoDenyFindings(pipeline);
  assertEquals(checkSubsets(findings), ["advisories", "bans licenses sources"]);
  assertEquals(findings.map((f) => f.kind === "command" && !!f.allowFailure), [
    true,
    false,
  ]);
  const text = yaml(
    "jobs:",
    "  deny:",
    "    defaults:",
    "      run:",
    "        working-directory: rust",
    "# a note",
    "    steps:",
    "      - run: cargo deny check",
  );
  assertEquals(summary(workflowCargoDenyFindings(text)), [[
    "check",
    "rust",
    false,
  ]]);
});

Deno.test("workflow: job defaults resolve cross-job YAML aliases", () => {
  const text = yaml(
    "jobs:",
    "  first:",
    "    defaults: &wd",
    "      run:",
    "        working-directory: rust",
    "    steps:",
    "      - run: echo ok",
    "  deny:",
    "    defaults: *wd",
    "    steps:",
    "      - run: cargo deny check",
  );
  assertEquals(summary(workflowCargoDenyFindings(text)), [[
    "check",
    "rust",
    false,
  ]]);
});

Deno.test("workflow: step anchors and aliases resolve across keys", () => {
  const text = yaml(
    "jobs:",
    "  deny:",
    "    steps:",
    "      - run: echo before",
    "      - run: &deny cargo deny check bans",
    "        working-directory: &rust rust",
    "        continue-on-error: &allow true",
    "      - run: *deny",
    "        working-directory: *rust",
    "        continue-on-error: *allow",
    "      - uses: &action EmbarkStudios/cargo-deny-action@v2",
    "        with: &inputs",
    "          command: check bans",
    "      - uses: *action",
    "        with: *inputs",
  );
  const findings = workflowCargoDenyFindings(text);
  assertEquals(checkSubsets(findings), ["bans", "bans", "bans", "bans"]);
  assertEquals(findings.map((f) => f.kind === "command" && f.cwd), [
    "rust",
    "rust",
    ".",
    ".",
  ]);
  assertEquals(findings.map((f) => f.kind === "command" && !!f.allowFailure), [
    true,
    true,
    false,
    false,
  ]);
});

Deno.test("workflow: parsed jobs enumerate anchored, aliased and flow steps", () => {
  const text = yaml(
    "jobs:",
    "  first: &job",
    "    defaults:",
    "      run:",
    "        working-directory: crate-a",
    "    steps: &steps",
    "      - run: &cmd cargo deny check bans",
    "        continue-on-error: &allow true",
    "  second:",
    "    defaults:",
    "      run:",
    "        working-directory: crate-b",
    "    steps: *steps",
    "  third:",
    "    steps: [{run: cargo deny check advisories}]",
  );
  const findings = workflowCargoDenyFindings(text);
  assertEquals(checkSubsets(findings), ["bans", "bans", "advisories"]);
  assertEquals(findings.map((f) => f.kind === "command" && f.cwd), [
    "crate-a",
    "crate-b",
    ".",
  ]);
  assertEquals(findings.map((f) => f.kind === "command" && !!f.allowFailure), [
    true,
    true,
    false,
  ]);
});

Deno.test("workflow: anchored job retains matrix and allowed failure", () => {
  const text = yaml(
    "jobs:",
    "  deny: &job",
    "    defaults:",
    "      run:",
    "        working-directory: rust",
    "    strategy:",
    "      matrix:",
    "        checks: [advisories, bans]",
    "    steps:",
    "      - run: cargo deny check ${{ matrix.checks }}",
    "        continue-on-error: ${{ matrix.checks == 'advisories' }}",
  );
  const findings = workflowCargoDenyFindings(text);
  assertEquals(checkSubsets(findings), ["advisories", "bans"]);
  assertEquals(findings.map((f) => f.kind === "command" && f.cwd), [
    "rust",
    "rust",
  ]);
  assertEquals(findings.map((f) => f.kind === "command" && !!f.allowFailure), [
    true,
    false,
  ]);
});

Deno.test("workflow: multi-wildcard path filters select only matching paths", () => {
  for (
    const [pattern, match, miss] of [
      ["**/*.rs", "src/main.rs", "README.md"],
      ["src/**/*.rs", "src/main.rs", "docs/main.rs"],
      ["**/Cargo.*", "crates/a/Cargo.toml", "src/main.rs"],
    ] as const
  ) {
    const text = pathFiltered(pattern);
    assertEquals(workflowCargoDenyFindings(text, { touched: [miss] }), []);
    assertEquals(
      workflowCargoDenyFindings(text, { touched: [match] }).length,
      1,
    );
  }
});

function pathFiltered(pattern: string): string {
  return yaml(
    "on:",
    "  pull_request:",
    `    paths: ['${pattern}']`,
    "jobs:",
    "  deny:",
    "    steps:",
    "      - run: cargo deny check",
  );
}

function pathRuns(pattern: string, touched: string): boolean {
  return workflowCargoDenyFindings(pathFiltered(pattern), {
    touched: [touched],
  }).length === 1;
}

Deno.test("workflow: a path pattern reads *, a literal dot, ? and + as GitHub does", () => {
  // `*` stops at `/`; `.` is literal.
  assertEquals(pathRuns("*.rs", "a.rs"), true);
  assertEquals(pathRuns("*.rs", "src/a.rs"), false);
  assertEquals(pathRuns("Cargo.lock", "Cargo.lock"), true);
  assertEquals(pathRuns("Cargo.lock", "CargoXlock"), false);
  // `?` makes the character before it optional; `+` repeats it.
  assertEquals(pathRuns("Cargo.loc?", "Cargo.loc"), true);
  assertEquals(pathRuns("Cargo.loc?", "Cargo.locc"), false);
  assertEquals(pathRuns("a+.rs", "aaa.rs"), true);
  assertEquals(pathRuns("a+.rs", "b.rs"), false);
  // A character class.
  assertEquals(pathRuns("[ab].rs", "a.rs"), true);
  assertEquals(pathRuns("[ab].rs", "c.rs"), false);
  assertEquals(pathRuns("[a-c].rs", "b.rs"), true);
  assertEquals(pathRuns("[a-c].rs", "d.rs"), false);
  assertEquals(pathRuns("[^a-c].rs", "d.rs"), true);
  assertEquals(pathRuns("[^a-c].rs", "b.rs"), false);
  assertEquals(pathRuns("[z-a].rs", "q.rs"), true);
});

Deno.test("workflow: a path pattern the gate cannot read selects the path", () => {
  // Multiple repetitions are matched without exponential backtracking.
  assertEquals(pathRuns("*a*a*a*b", "aaaaaaaaaaaaaaaaaaaa"), false);
  assertEquals(pathRuns("*a*a*a*b", "aaaaab"), true);
  const ignored = pathFiltered("*a*a*a*b").replace(
    "    paths:",
    "    paths-ignore:",
  );
  assertEquals(
    workflowCargoDenyFindings(ignored, { touched: ["a"] }).length,
    1,
  );
  // Over the length cap: not read, so it selects instead of failing to match.
  assertEquals(pathRuns("a".repeat(250), "b"), true);
  // An unclosed class.
  assertEquals(pathRuns("a[b", "z"), true);
  // A trailing backslash is a literal one, not an escape of nothing.
  assertEquals(pathRuns("a\\", "a"), false);
  assertEquals(pathRuns("a\\", "a\\"), true);
  // A quantifier with nothing before it is an invalid regex, so it selects.
  assertEquals(pathRuns("?a", "b"), true);
});

Deno.test("workflow: a paths filter holding a non-string entry is not read", () => {
  const text = yaml(
    "on:",
    "  pull_request:",
    "    paths: [1, 2]",
    "jobs:",
    "  deny:",
    "    steps:",
    "      - run: cargo deny check",
  );
  assertEquals(
    workflowCargoDenyFindings(text, { touched: ["a.rs"] }).length,
    1,
  );
});
