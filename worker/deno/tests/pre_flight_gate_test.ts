/**
 * Tests for the pre-flight enforcement gate (Issue #3577).
 *
 * The regression that matters is fail-open: a command that cannot be started
 * or that times out must BLOCK, never be reported as a pass. These tests
 * assert on the distinct `reason` string, not just the boolean, so a future
 * refactor that swallows a spawn error into "passed" fails here.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  PRE_FLIGHT_DEFAULT_TIMEOUT_SECONDS,
  type PreFlightCommandResult,
  PreFlightGateError,
  type PreFlightRunner,
  runPreFlightGate,
  tokeniseCommand,
} from "../lib/pre_flight_gate.ts";
import { TIMEOUT_EXIT_CODE } from "../lib/git_timeout.ts";

/** Build a runner that records the commands it saw and returns scripted results. */
function scriptedRunner(
  results: Record<string, PreFlightCommandResult>,
): { runner: PreFlightRunner; calls: string[] } {
  const calls: string[] = [];
  const runner: PreFlightRunner = (command) => {
    calls.push(command);
    const result = results[command];
    if (!result) {
      throw new Error(`unexpected command in test: ${command}`);
    }
    return Promise.resolve(result);
  };
  return { runner, calls };
}

const ok = (): PreFlightCommandResult => ({
  started: true,
  code: 0,
  stdout: "",
  stderr: "",
});

Deno.test("runPreFlightGate - empty command list runs nothing and passes", async () => {
  let invoked = false;
  const runner: PreFlightRunner = () => {
    invoked = true;
    return Promise.resolve(ok());
  };

  const result = await runPreFlightGate([], { runner });

  assert(result.ok, "empty gate must pass");
  assertEquals(invoked, false, "no command should run when the list is empty");
});

Deno.test("runPreFlightGate - all commands exit 0 → passes", async () => {
  const { runner, calls } = scriptedRunner({
    "./a.sh": ok(),
    "./b.sh": ok(),
  });

  const result = await runPreFlightGate(["./a.sh", "./b.sh"], { runner });

  assert(result.ok, "gate should pass when every command exits 0");
  assertEquals(calls, ["./a.sh", "./b.sh"], "commands run in listed order");
});

Deno.test("runPreFlightGate - non-zero exit blocks with reason non-zero-exit", async () => {
  const { runner } = scriptedRunner({
    "./build.sh": {
      started: true,
      code: 2,
      stdout: "Compiling…",
      stderr: "error: cannot find symbol",
    },
  });

  const result = await runPreFlightGate(["./build.sh"], { runner });

  assert(!result.ok, "non-zero exit must block");
  if (!result.ok) {
    assert(result.error instanceof PreFlightGateError);
    assertEquals(result.error.reason, "non-zero-exit");
    assertEquals(result.error.exitCode, 2);
    // Captured output is surfaced so the fixer sees the real compiler error.
    assert(
      result.error.output.includes("cannot find symbol"),
      "failing command output must be surfaced",
    );
    assert(result.error.output.includes("Compiling"), "stdout captured too");
  }
});

Deno.test("runPreFlightGate - second command does NOT run after the first fails", async () => {
  const { runner, calls } = scriptedRunner({
    "./first.sh": { started: true, code: 1, stdout: "", stderr: "boom" },
    "./second.sh": ok(),
  });

  const result = await runPreFlightGate(["./first.sh", "./second.sh"], {
    runner,
  });

  assert(!result.ok, "first failure must abort the gate");
  assertEquals(calls, ["./first.sh"], "the second command must not run");
});

Deno.test("runPreFlightGate - unstartable command blocks with a DISTINCT reason, never a pass", async () => {
  // The command could not even be started (missing / not executable).
  const { runner } = scriptedRunner({
    "./missing.sh": {
      started: false,
      code: -1,
      stdout: "",
      stderr: "No such file or directory (os error 2)",
    },
  });

  const result = await runPreFlightGate(["./missing.sh"], { runner });

  assert(!result.ok, "'could not run the check' must be a block, never a pass");
  if (!result.ok) {
    assert(result.error instanceof PreFlightGateError);
    // Distinct reason — this is the fail-open regression guard.
    assertEquals(result.error.reason, "not-started");
    assert(
      result.error.reason !== "non-zero-exit",
      "unstartable must NOT be classified as a check failure",
    );
    assert(
      /could not be started/i.test(result.error.message),
      "message must be distinct from 'check failed'",
    );
  }
});

Deno.test("runPreFlightGate - timeout blocks with reason timeout", async () => {
  const { runner } = scriptedRunner({
    "./slow.sh": {
      started: true,
      code: TIMEOUT_EXIT_CODE,
      stdout: "",
      stderr: "timed out",
      timedOut: true,
    },
  });

  const result = await runPreFlightGate(["./slow.sh"], {
    runner,
    timeoutSeconds: 5,
  });

  assert(!result.ok, "a timeout must block");
  if (!result.ok) {
    assert(result.error instanceof PreFlightGateError);
    assertEquals(result.error.reason, "timeout");
    assert(
      /timed out/i.test(result.error.message),
      "message states the timeout",
    );
  }
});

Deno.test("runPreFlightGate - default timeout is generous for long builds", () => {
  // These builds legitimately take many minutes — 30 minutes by default.
  assertEquals(PRE_FLIGHT_DEFAULT_TIMEOUT_SECONDS, 1800);
});

Deno.test("tokeniseCommand - splits program and args, honours quotes", () => {
  assertEquals(tokeniseCommand("./pre-flight.sh"), ["./pre-flight.sh"]);
  assertEquals(tokeniseCommand("mvn -q compile"), ["mvn", "-q", "compile"]);
  assertEquals(
    tokeniseCommand(`sh -c "echo hi there"`),
    ["sh", "-c", "echo hi there"],
  );
  assertEquals(tokeniseCommand("   "), []);
});

// --- Real subprocess: genuinely missing binary is classified not-started ---

Deno.test("runPreFlightGate - real missing binary is not-started (fail loud)", async () => {
  const result = await runPreFlightGate(
    ["./definitely-not-a-real-command-3577"],
    { timeoutSeconds: 30 },
  );

  assert(!result.ok, "a genuinely missing command must block");
  if (!result.ok) {
    assert(result.error instanceof PreFlightGateError);
    assertEquals(
      result.error.reason,
      "not-started",
      "a missing binary must be 'not-started', never a silent pass",
    );
  }
});

Deno.test("runPreFlightGate - real non-zero exit is non-zero-exit", async () => {
  const result = await runPreFlightGate(["false"], { timeoutSeconds: 30 });

  assert(!result.ok, "a command exiting non-zero must block");
  if (!result.ok) {
    assert(result.error instanceof PreFlightGateError);
    assertEquals(result.error.reason, "non-zero-exit");
  }
});

Deno.test("runPreFlightGate - real success passes", async () => {
  const result = await runPreFlightGate(["true"], { timeoutSeconds: 30 });
  assert(result.ok, "a command exiting 0 must pass");
});
