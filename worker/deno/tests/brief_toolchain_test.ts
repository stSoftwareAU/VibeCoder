/**
 * Tests for the brief toolchain runner (Issue #2602, part of #2581).
 *
 * brief is never spawned for real: every test drives the runner through its
 * spawn seam and asserts on the argv it was handed and the result it returns.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BRIEF_BINARY,
  briefScanArgs,
  type BriefSpawn,
  createBriefRunner,
  extractCargoCommands,
  MAX_BRIEF_COMMAND_LENGTH,
  MAX_BRIEF_COMMANDS,
  sanitiseCargoCommands,
} from "../lib/brief_toolchain.ts";
import {
  DEFAULT_SUBPROCESS_TIMEOUT_MS,
  type SubprocessResult,
} from "../lib/subprocess_timeout.ts";

const REPO = "/work/org/rusty";

/** A brief v0.13.0 JSON report shaped like a Rust project's. */
function rustReport(): Record<string, unknown> {
  return {
    version: "0.13.0",
    path: REPO,
    languages: [{
      name: "Rust",
      category: "language",
      confidence: "high",
      command: { run: "cargo build", source: "knowledge" },
    }],
    package_managers: [{
      name: "Cargo",
      category: "package_manager",
      confidence: "high",
      command: { run: "cargo fetch", source: "knowledge" },
    }],
    scripts: [{ name: "ci", run: "make ci", source: "Makefile" }],
    tools: {
      test: [{
        name: "cargo test",
        category: "test",
        command: {
          run: "cargo test",
          alternatives: ["cargo nextest run"],
          source: "knowledge",
        },
      }],
      lint: [{
        name: "Clippy",
        category: "lint",
        command: { run: "cargo clippy -- -D warnings", source: "knowledge" },
      }],
      format: [{
        name: "rustfmt",
        category: "format",
        command: { run: "cargo fmt", source: "knowledge" },
      }],
    },
    stats: { duration_ms: 12.5 },
  };
}

function ok(stdout: string): SubprocessResult {
  return { success: true, code: 0, stdout, stderr: "", timedOut: false };
}

/** A spawn seam that records its calls and replies with `reply`. */
function recordingSpawn(
  reply: Awaited<ReturnType<BriefSpawn>>,
): {
  spawn: BriefSpawn;
  calls: { exe: string; args: string[]; timeoutMs: number }[];
} {
  const calls: { exe: string; args: string[]; timeoutMs: number }[] = [];
  const spawn: BriefSpawn = (exe, args, options) => {
    calls.push({ exe, args, timeoutMs: options.timeoutMs });
    return Promise.resolve(reply);
  };
  return { spawn, calls };
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

Deno.test("createBriefRunner - spawns brief with the fixed offline scan argv and no shell", async () => {
  const { spawn, calls } = recordingSpawn({
    ok: true,
    value: ok(JSON.stringify(rustReport())),
  });
  const runner = createBriefRunner({ spawn });

  await runner(REPO);

  assertEquals(calls.length, 1);
  // The binary itself — never `sh -c`, `bash` or an `env` wrapper.
  assertEquals(calls[0]?.exe, "brief");
  assertEquals(BRIEF_BINARY, "brief");
  // The default local scan (no subcommand), JSON forced, then the repo path.
  assertEquals(calls[0]?.args, ["--json", REPO]);
  assertEquals(calls[0]?.timeoutMs, DEFAULT_SUBPROCESS_TIMEOUT_MS);
});

Deno.test("briefScanArgs - never names a network-facing subcommand", () => {
  const args = briefScanArgs(REPO);
  for (const forbidden of ["enrich", "outline", "diff", "--cache", "--dir"]) {
    assert(!args.includes(forbidden), `argv must not carry ${forbidden}`);
  }
  assertEquals(args[args.length - 1], REPO);
});

Deno.test("createBriefRunner - refuses a path brief would treat as remote", async () => {
  const { spawn, calls } = recordingSpawn({ ok: true, value: ok("{}") });
  const runner = createBriefRunner({ spawn });

  for (
    const remote of [
      "https://github.com/org/repo",
      "crate:serde",
      "relative/dir",
      "--json",
      "",
    ]
  ) {
    const result = await runner(remote);
    assertEquals(result.status, "failed", `${remote} must be refused`);
  }
  assertEquals(calls.length, 0, "a refused path is never spawned");
});

Deno.test("createBriefRunner - honours a caller-supplied timeout", async () => {
  const { spawn, calls } = recordingSpawn({
    ok: true,
    value: ok(JSON.stringify(rustReport())),
  });
  await createBriefRunner({ spawn, timeoutMs: 5_000 })(REPO);
  assertEquals(calls[0]?.timeoutMs, 5_000);
});

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

Deno.test("createBriefRunner - returns ok with the Cargo commands and wall-clock seconds", async () => {
  const { spawn } = recordingSpawn({
    ok: true,
    value: ok(JSON.stringify(rustReport())),
  });
  const ticks = [1_000, 3_250];
  const runner = createBriefRunner({ spawn, now: () => ticks.shift()! });

  const result = await runner(REPO);

  assertEquals(result, {
    status: "ok",
    commands: [
      "cargo build",
      "cargo fetch",
      "cargo test",
      "cargo nextest run",
      "cargo clippy -- -D warnings",
      "cargo fmt",
    ],
    seconds: 2.25,
  });
});

Deno.test("createBriefRunner - a missing binary is failed, never thrown", async () => {
  const { spawn } = recordingSpawn({
    ok: false,
    error: new Error("Failed to spawn 'brief': No such file or directory"),
  });
  const result = await createBriefRunner({ spawn })(REPO);
  assertEquals(result.status, "failed");
  assert(result.status === "failed");
  assertStringIncludes(result.reason, "could not be spawned");
});

Deno.test("createBriefRunner - a thrown spawn is failed, never propagated", async () => {
  const spawn: BriefSpawn = () => Promise.reject(new Error("boom"));
  const result = await createBriefRunner({ spawn })(REPO);
  assert(result.status === "failed");
  assertStringIncludes(result.reason, "boom");
});

Deno.test("createBriefRunner - a non-zero exit is failed with the code", async () => {
  const { spawn } = recordingSpawn({
    ok: true,
    value: {
      success: false,
      code: 2,
      stdout: "",
      stderr: "error: open Cargo.toml: permission denied\nmore",
      timedOut: false,
    },
  });
  const result = await createBriefRunner({ spawn })(REPO);
  assert(result.status === "failed");
  assertStringIncludes(result.reason, "exited with code 2");
  assertStringIncludes(result.reason, "permission denied");
  assert(!result.reason.includes("\n"), "the reason stays one line");
});

Deno.test("createBriefRunner - a timeout is failed", async () => {
  const { spawn } = recordingSpawn({
    ok: true,
    value: {
      success: false,
      code: 124,
      stdout: "",
      stderr: "Timed out after 30000ms",
      timedOut: true,
    },
  });
  const result = await createBriefRunner({ spawn })(REPO);
  assert(result.status === "failed");
  assertStringIncludes(result.reason, "timed out");
});

Deno.test("createBriefRunner - unparseable output is failed", async () => {
  for (const stdout of ["not json", "[1,2]", "null", ""]) {
    const { spawn } = recordingSpawn({ ok: true, value: ok(stdout) });
    const result = await createBriefRunner({ spawn })(REPO);
    assertEquals(result.status, "failed", `${JSON.stringify(stdout)}`);
  }
});

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

Deno.test("extractCargoCommands - keeps only allowlisted, capped Cargo commands", () => {
  const overLong = `cargo test ${"x".repeat(MAX_BRIEF_COMMAND_LENGTH)}`;
  const report = {
    languages: [],
    package_managers: [{ command: { run: "npm install" } }],
    scripts: [
      { run: "make test" },
      { run: "cargo run --bin demo" },
      { run: 42 },
    ],
    tools: {
      test: [
        { command: { run: "cargo test\u0007" } },
        { command: { run: "cargo test\nrm -rf /" } },
        { command: { run: overLong } },
        { command: { run: "cargo-audit audit" } },
        { command: { run: "cargo test --all" } },
        { command: { run: "cargo test --all" } },
        { command: { run: "cargo `whoami`" } },
      ],
      lint: [{ command: null }, "junk", { command: { run: "cargo clippy" } }],
    },
  };

  const result = extractCargoCommands(JSON.stringify(report));

  assert(result.ok);
  // Detections first, then scripts — first-seen order, de-duplicated.
  assertEquals(result.value, [
    "cargo test --all",
    "cargo clippy",
    "cargo run --bin demo",
  ]);
});

Deno.test("sanitiseCargoCommands - caps the command count", () => {
  const many = Array.from(
    { length: MAX_BRIEF_COMMANDS + 5 },
    (_, i) => `cargo run --example e${i}`,
  );
  const kept = sanitiseCargoCommands(many);
  assertEquals(kept.length, MAX_BRIEF_COMMANDS);
  assertEquals(kept[0], "cargo run --example e0");
});

Deno.test("sanitiseCargoCommands - drops bidi and zero-width characters", () => {
  assertEquals(
    sanitiseCargoCommands([
      "cargo test\u202e",
      "cargo\u200b build",
      "cargo doc",
    ]),
    ["cargo doc"],
  );
});

Deno.test("sanitiseCargoCommands - drops tag characters and soft hyphens", () => {
  assertEquals(
    sanitiseCargoCommands([
      "cargo test\u{E0049}\u{E0067}",
      "cargo test\u00ad",
      "cargo test\u2028",
      "cargo bench",
    ]),
    ["cargo bench"],
  );
});

Deno.test("extractCargoCommands - an empty report is ok with no commands", () => {
  const result = extractCargoCommands("{}");
  assert(result.ok);
  assertEquals(result.value, []);
});

Deno.test("extractCargoCommands - rejects output that is not a JSON object", () => {
  assertEquals(extractCargoCommands("brief dev — /repo").ok, false);
  assertEquals(extractCargoCommands('"cargo test"').ok, false);
});
