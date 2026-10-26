/**
 * Tests for the static best-practices scan's build-tool guard (Issue #4415).
 *
 * Covers the command classifier, the `PreToolUse` decision, the CLI's output
 * and the hook settings the scan installs. The end-to-end fixture, which runs
 * the real `defaultRunScan` against a Rust project, is in
 * `static_scan_cargo_build_script_test.ts`.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  decideStaticScanHook,
  findStaticScanBuildInvocation,
  resolveStaticScanHookSettings,
  STATIC_SCAN_BUILD_TOOLS,
  STATIC_SCAN_DENIAL_MARKER,
  STATIC_SCAN_DISALLOWED_BASH_TOOLS,
  STATIC_SCAN_GUARD_MODULE,
} from "../lib/static_scan_guard.ts";
import { runStaticScanGuard } from "../lib/static_scan_guard_cli.ts";

/** Commands the scan must refuse, with the build tool each one invokes. */
const DENIED: ReadonlyArray<readonly [string, string]> = [
  ["cargo check", "cargo"],
  ["cargo check --offline", "cargo"],
  ["cargo clippy --offline", "cargo"],
  ["cargo test", "cargo"],
  ["rustc --version", "rustc"],
  ["rustup show", "rustup"],
  ["rustdoc src/lib.rs", "rustdoc"],
  ["clippy-driver --help", "clippy-driver"],
  ["cargo-clippy clippy", "cargo-clippy"],
  ["cargo-deny check", "cargo-deny"],
  ["FOO=1 cargo check", "cargo"],
  ["cd x && cargo clippy", "cargo"],
  ["cargo check; echo done", "cargo"],
  ["echo ok\ncargo check", "cargo"],
  ["echo $(cargo check)", "cargo"],
  ["echo `cargo check`", "cargo"],
  ["env cargo check --offline", "cargo"],
  ["env -i HOME=/tmp cargo check", "cargo"],
  ["bash -c 'cargo check'", "cargo"],
  ['sh -c "cargo clippy"', "cargo"],
  ["bash -lc 'ls && cargo clippy'", "cargo"],
  ["zsh -c 'bash -c \"cargo clippy\"'", "cargo"],
  ["cargo +nightly clippy", "cargo"],
  ["/usr/local/bin/cargo check", "cargo"],
  ["~/.cargo/bin/cargo check", "cargo"],
  ['"cargo" check', "cargo"],
  ["'cargo' check", "cargo"],
  ["rustup run stable cargo check", "cargo"],
  ["nice -n 5 cargo check", "cargo"],
  ["timeout 60 cargo check", "cargo"],
  ["timeout -s KILL 60 cargo check", "cargo"],
  ["sudo -u builder cargo check", "cargo"],
  ["time -p cargo check", "cargo"],
  ["nohup cargo check", "cargo"],
  ["xargs cargo check", "cargo"],
  ["if true; then cargo check; fi", "cargo"],
  ["2>/dev/null cargo check", "cargo"],
  ["! cargo check", "cargo"],
];

/** Commands the scan must allow: cargo only as an argument, or no cargo at all. */
const ALLOWED: readonly string[] = [
  "grep -n cargo Cargo.toml",
  "grep -Hn unwrap src/lib.rs",
  'rg "cargo check" .github',
  "echo cargo",
  "echo 'cargo check'",
  "cat Cargo.lock",
  "ls ~/.cargo",
  "find . -name '*.rs'",
  'gh issue create --title "cargo clippy finding"',
  "git status",
  "ls -la",
  "cat Cargo.toml | grep -n name",
  "",
];

for (const [command, tool] of DENIED) {
  Deno.test(`static scan guard - denies ${JSON.stringify(command)} as ${tool} (Issue #4415)`, () => {
    assertEquals(findStaticScanBuildInvocation(command), tool);
  });
}

for (const command of ALLOWED) {
  Deno.test(`static scan guard - allows ${JSON.stringify(command)} (Issue #4415)`, () => {
    assertEquals(findStaticScanBuildInvocation(command), undefined);
  });
}

Deno.test("static scan guard - a separator inside double quotes over-matches and denies (Issue #4415)", () => {
  // Fail-closed by design: separators are honoured inside double quotes, so a
  // build tool hidden behind one is still reached.
  assertEquals(
    findStaticScanBuildInvocation('echo "a; cargo check"'),
    "cargo",
  );
});

Deno.test("static scan guard - a single-quoted separator is literal and allowed (Issue #4415)", () => {
  assertEquals(
    findStaticScanBuildInvocation("echo 'a; cargo check'"),
    undefined,
  );
});

Deno.test("static scan guard - hostile input completes with a plain answer (Issue #4415)", () => {
  // A long run of one repeated character: no regex may backtrack on it.
  assertEquals(findStaticScanBuildInvocation("a".repeat(200_000)), undefined);
  assertEquals(
    findStaticScanBuildInvocation("-" + "c".repeat(200_000)),
    undefined,
  );
  assertEquals(
    findStaticScanBuildInvocation("X" + "=".repeat(100_000) + " cargo check"),
    "cargo",
  );
  assertEquals(
    findStaticScanBuildInvocation("bash -" + "c".repeat(100_000) + " 'ls'"),
    undefined,
  );
});

Deno.test("static scan guard - the build tool list is one source for the Bash rules (Issue #4415)", () => {
  for (const tool of STATIC_SCAN_BUILD_TOOLS) {
    assert(STATIC_SCAN_DISALLOWED_BASH_TOOLS.includes(`Bash(${tool}:*)`));
  }
  assert(STATIC_SCAN_DISALLOWED_BASH_TOOLS.includes("Bash(cargo-clippy:*)"));
  assertEquals(STATIC_SCAN_BUILD_TOOLS, [
    "cargo",
    "rustc",
    "rustup",
    "rustdoc",
    "clippy-driver",
  ]);
});

Deno.test("static scan guard - denies a cargo Bash call with the marker and cause (Issue #4415)", () => {
  const decision = decideStaticScanHook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "cargo check --offline" },
  });
  assert(decision.deny);
  assertEquals(decision.tool, "cargo");
  assert(decision.reason.startsWith(STATIC_SCAN_DENIAL_MARKER));
  assertStringIncludes(decision.reason, "build scripts (build.rs)");
  assertStringIncludes(decision.reason, "proc macros");
  assertStringIncludes(decision.reason, "including those of dependencies");
  assertStringIncludes(decision.reason, "build artefacts (target/)");
  assertStringIncludes(decision.reason, "a static scan does not run them");
  assertStringIncludes(
    decision.reason,
    "Report compiler corroboration as not checked",
  );
  assert(
    !decision.reason.toLowerCase().includes("sandbox"),
    "the denial must not describe the guard as a sandbox",
  );
});

Deno.test("static scan guard - allows the legal sibling with the same shape (Issue #4415)", () => {
  const decision = decideStaticScanHook({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "grep -Hn unwrap src/lib.rs" },
  });
  assertEquals(decision, { deny: false });
});

Deno.test("static scan guard - allows a non-Bash tool and other events (Issue #4415)", () => {
  assertEquals(
    decideStaticScanHook({
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: { command: "cargo check" },
    }),
    { deny: false },
  );
  assertEquals(
    decideStaticScanHook({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "cargo check" },
    }),
    { deny: false },
  );
});

Deno.test("static scan guard - denies a Bash call with a missing or non-string command (fail closed, Issue #4415)", () => {
  for (
    const input of [
      { hook_event_name: "PreToolUse", tool_name: "Bash" },
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} },
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: 42 },
      },
    ]
  ) {
    const decision = decideStaticScanHook(input);
    assert(decision.deny, `expected a denial for ${JSON.stringify(input)}`);
    assert(decision.reason.startsWith(STATIC_SCAN_DENIAL_MARKER));
    assertStringIncludes(decision.reason, "fails closed");
  }
});

Deno.test("static scan guard - denies a payload that is not an object (fail closed, Issue #4415)", () => {
  for (const payload of [null, 7, "cargo check", []]) {
    assertEquals(decideStaticScanHook(payload).deny, true);
  }
});

Deno.test("static scan guard CLI - denies an unparseable payload on stdout and stderr (fail closed, Issue #4415)", () => {
  const out: string[] = [];
  const err: string[] = [];
  runStaticScanGuard("{not json", {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  assertEquals(out.length, 1);
  const parsed = JSON.parse(out[0]!);
  assertEquals(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  assertEquals(parsed.hookSpecificOutput.permissionDecision, "deny");
  assert(
    parsed.hookSpecificOutput.permissionDecisionReason.startsWith(
      STATIC_SCAN_DENIAL_MARKER,
    ),
  );
  assertStringIncludes(
    parsed.hookSpecificOutput.permissionDecisionReason,
    "could not parse",
  );
  assertEquals(err.length, 1);
  assertStringIncludes(err[0]!, STATIC_SCAN_DENIAL_MARKER);
});

Deno.test("static scan guard CLI - denies a cargo payload with the decision and a log line (Issue #4415)", () => {
  const out: string[] = [];
  const err: string[] = [];
  runStaticScanGuard(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "cargo clippy --offline" },
    }),
    { out: (text) => out.push(text), err: (text) => err.push(text) },
  );
  assertEquals(out.length, 1);
  const parsed = JSON.parse(out[0]!);
  assertEquals(parsed.hookSpecificOutput.permissionDecision, "deny");
  assertStringIncludes(
    parsed.hookSpecificOutput.permissionDecisionReason,
    "build scripts",
  );
  assertEquals(err.length, 1);
  assertStringIncludes(err[0]!, "cargo");
});

Deno.test("static scan guard CLI - writes nothing for an allowed command (Issue #4415)", () => {
  const out: string[] = [];
  const err: string[] = [];
  runStaticScanGuard(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "grep -Hn unwrap src/lib.rs" },
    }),
    { out: (text) => out.push(text), err: (text) => err.push(text) },
  );
  assertEquals(out, []);
  assertEquals(err, []);
});

Deno.test("static scan hook settings - a PreToolUse Bash hook referencing the guard module (Issue #4415)", () => {
  const settings = resolveStaticScanHookSettings({
    denoPath: "/usr/bin/deno",
    guardModulePath: "/checkout/worker/deno/lib/static_scan_guard_cli.ts",
  }) as {
    hooks: {
      PreToolUse: {
        matcher: string;
        hooks: { type: string; command: string }[];
      }[];
    };
  };
  assertEquals(settings.hooks.PreToolUse.length, 1);
  const entry = settings.hooks.PreToolUse[0]!;
  assertEquals(entry.matcher, "Bash");
  assertEquals(entry.hooks[0]!.type, "command");
  assertStringIncludes(entry.hooks[0]!.command, "/usr/bin/deno");
  assertStringIncludes(
    entry.hooks[0]!.command,
    "/checkout/worker/deno/lib/static_scan_guard_cli.ts",
  );
});

Deno.test("static scan hook settings - the default guard path is the guard module (Issue #4415)", () => {
  const settings = resolveStaticScanHookSettings() as {
    hooks: { PreToolUse: { matcher: string; hooks: { command: string }[] }[] };
  };
  const entry = settings.hooks.PreToolUse[0]!;
  assertEquals(entry.matcher, "Bash");
  assertStringIncludes(entry.hooks[0]!.command, STATIC_SCAN_GUARD_MODULE);
});
