/**
 * Tests for the pre-push gate's `deno test` baseline and outage handling
 * (Issue #4930, PR #5034 review).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type DenoTestBaseline,
  denoTestFailureKeys,
  isDenoFetchFailure,
  judgeDenoTestFailure,
  unitTestCommand,
} from "../lib/deno_test_baseline.ts";
import { PreFlightGateError } from "../lib/pre_flight_gate.ts";

// Output shape observed from `deno test` 2.x (ERRORS then FAILURES sections).
const OBSERVED = `running 3 tests from ./a_test.ts
boom one ... FAILED (403µs)
nested ...
  inner ... FAILED (0ms)

 ERRORS 

boom one => ./a_test.ts:1:6
error: Error: x

nested ... inner => ./a_test.ts:3:44
error: Error: y

 FAILURES 

boom one => ./a_test.ts:1:6
nested ... inner => ./a_test.ts:3:44

FAILED | 1 passed | 2 failed (1 step) (4ms)
`;

function failure(
  output: string,
  reason: PreFlightGateError["reason"] = "non-zero-exit",
): PreFlightGateError {
  return new PreFlightGateError({
    reason,
    command: "deno task test:unit",
    exitCode: 1,
    output,
    message: `blocked: ${output.slice(0, 20)}`,
  });
}

const command = (files: string[]) => unitTestCommand(files);

Deno.test("denoTestFailureKeys: names failed tests and steps, ignoring line and colour", () => {
  assertEquals(
    [...denoTestFailureKeys(OBSERVED)].sort(),
    ["boom one => ./a_test.ts", "nested ... inner => ./a_test.ts"],
  );
  assertEquals(
    [...denoTestFailureKeys("\x1b[31mboom one => ./a_test.ts:9:6\x1b[0m\n")],
    ["boom one => ./a_test.ts"],
  );
  assertEquals(denoTestFailureKeys("error: boom\n").size, 0);
});

Deno.test("isDenoFetchFailure: observed fetch errors are outages, a 404 and a named failure are not", () => {
  for (
    const line of [
      "error: JSR package manifest for '@std/path' failed to load. Import 'http://127.0.0.1:9/@std/path/meta.json' failed.",
      "error: Import 'https://127.0.0.1:9/x.ts' failed.",
      'error: Failed loading http://127.0.0.1:9/left-pad for package "left-pad"',
      "    0: error sending request for url (https://x/y): client error (Connect)",
      "error: Failed caching npm package 'x@1'",
      "error: unexpected 503 Service Unavailable",
    ]
  ) {
    assert(isDenoFetchFailure(`Download x\n${line}\n`), line);
  }
  assertEquals(
    isDenoFetchFailure("error: JSR package not found: @std/nonexistent-zzz\n"),
    false,
  );
  assertEquals(
    isDenoFetchFailure(
      "error sending request for url (https://x)\n" + OBSERVED,
    ),
    false,
    "a named failed test is a test verdict",
  );
  // A long run that no pattern matches stays linear and unmatched.
  assertEquals(isDenoFetchFailure("e".repeat(200_000) + "\n"), false);
});

Deno.test("judgeDenoTestFailure: an outage and a missing deno are infrastructure", async () => {
  const outage = await judgeDenoTestFailure(
    failure(
      "error: JSR package manifest for '@std/path' failed to load. Import 'x' failed.\n",
    ),
    null,
    command,
  );
  assertEquals(outage.kind, "infrastructure");
  assertStringIncludes(
    (outage as { message: string }).message,
    "JSR package manifest",
  );
  const missing = await judgeDenoTestFailure(
    failure("deno: command not found", "not-started"),
    null,
    command,
  );
  assertEquals(missing.kind, "infrastructure");
  // A timeout is a verdict: a hung test is the branch's to fix.
  const timeout = await judgeDenoTestFailure(
    failure("", "timeout"),
    null,
    command,
  );
  assertEquals(timeout.kind, "verdict");
});

Deno.test("judgeDenoTestFailure: base-only needs every failed test red at the base", async () => {
  const seen: string[][] = [];
  const baseline = (
    output: string | null,
    ranFiles = ["./a_test.ts"],
  ): DenoTestBaseline => ({
    runAtBase: (build, files) => {
      seen.push(files);
      assertEquals(build(files), "deno task test:unit 'a_test.ts'");
      return Promise.resolve({
        ranFiles,
        error: output === null ? null : failure(output),
      });
    },
  });
  const same = await judgeDenoTestFailure(
    failure(OBSERVED),
    baseline(OBSERVED),
    command,
  );
  assertEquals(same.kind, "base-only");
  assertEquals(seen, [["./a_test.ts"]]);

  // The base passes: the branch broke it.
  assertEquals(
    (await judgeDenoTestFailure(failure(OBSERVED), baseline(null), command))
      .kind,
    "verdict",
  );
  // The base fails only one of the two tests.
  assertEquals(
    (await judgeDenoTestFailure(
      failure(OBSERVED),
      baseline("boom one => ./a_test.ts:1:6\n"),
      command,
    )).kind,
    "verdict",
  );
  // The file does not exist at the base.
  assertEquals(
    (await judgeDenoTestFailure(
      failure(OBSERVED),
      baseline(OBSERVED, []),
      command,
    )).kind,
    "verdict",
  );
  // No baseline, an unavailable baseline, and output naming no test.
  assertEquals(
    (await judgeDenoTestFailure(failure(OBSERVED), null, command)).kind,
    "verdict",
  );
  assertEquals(
    (await judgeDenoTestFailure(
      failure(OBSERVED),
      { runAtBase: () => Promise.resolve(null) },
      command,
    )).kind,
    "verdict",
  );
  assertEquals(
    (await judgeDenoTestFailure(failure("boom"), baseline("boom"), command))
      .kind,
    "verdict",
  );
  // A test path that is not a plain relative _test.ts is never re-run.
  assertEquals(
    (await judgeDenoTestFailure(
      failure("x => ./../evil_test.ts:1:1\n"),
      baseline("x => ./../evil_test.ts:1:1\n"),
      command,
    )).kind,
    "verdict",
  );
});

Deno.test("unitTestCommand: quotes each path and refuses one it cannot quote", () => {
  assertEquals(
    unitTestCommand(["./tests/a_test.ts", "tests/b_test.ts"]),
    "deno task test:unit 'tests/a_test.ts' 'tests/b_test.ts'",
  );
  assertEquals(unitTestCommand([`tests/a'"_test.ts`]), null);
});
