/**
 * Tests for checkov_check.ts (Issue #3972).
 *
 * Covers:
 *   - route selection: a PATH checkov is used only when it reports exactly the
 *     CI pin; a version mismatch falls through to the container route, and an
 *     empty version is named as an unknown version in the SKIPPED reason;
 *   - the container route runs only an image already held locally (`image
 *     inspect`), never `pull`, and mounts the repository read-only with
 *     `--entrypoint checkov`, as `checkov.yml` does;
 *   - loud SKIPPED, naming each unusable route, when no route is available;
 *   - the PATH route runs with a built environment (no `CKV_*`, `BC_*` or
 *     `PRISMA_*` variable, an empty private HOME) and the container route passes
 *     none;
 *   - a `.checkov.yaml` / `.checkov.yml` in the scanned directory is FAILED
 *     before any route is tried, even when no route exists;
 *   - a deadline hit is FAILED, never SKIPPED or PASSED;
 *   - the verdict comes from the shared judge (`judgeCheckovRun`), and a
 *     FAILED non-JSON run shows the tail of stderr, redacted before the cut;
 *   - the default template reader returns null for a missing file and rethrows
 *     any other read fault;
 *   - the real quality gate registers the check only where `checkov.yml`
 *     exists.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildCheckovContainerArgs,
  CHECKOV_DEADLINE_MS,
  type CheckovRunResult,
  checkovTemplateReader,
  type ProbeFn,
  runCheckovCheck,
  type SpawnFn,
} from "../lib/checkov_check.ts";
import { CHECKOV_SCAN_ARGS } from "../lib/checkov_report.ts";
import { CHECKOV_IMAGE, CHECKOV_IMAGE_TAG } from "../lib/pinned_actions.ts";
import { spawnWithDeadline } from "../lib/semgrep_check.ts";
import { runQualityGate } from "../lib/quality_gate.ts";
import {
  type CheckResult,
  formatSummary,
  recordCheck,
} from "../lib/quality_helpers.ts";

const FIXTURES = new URL("./fixtures/checkov/", import.meta.url);

/** Reads a checkov fixture's `report.json`. */
async function report(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`${name}/report.json`, FIXTURES));
}

/**
 * A probe answering from a fixed map of `binary args-joined` keys. Anything
 * not listed returns null (the binary or the image is unavailable). Every call
 * is recorded so tests can assert which commands were tried.
 */
function fakeProbe(
  answers: Record<string, string>,
  calls: string[][] = [],
): ProbeFn {
  return (binary: string, args: string[]) => {
    calls.push([binary, ...args]);
    const key = [binary, ...args].join(" ");
    const hit = answers[key];
    return Promise.resolve(hit ?? null);
  };
}

/** A spawner that records its arguments and returns a fixed result. */
function fakeSpawn(
  result: CheckovRunResult,
  calls: SpawnCall[],
): SpawnFn {
  return (binary, args, cwd, deadlineMs, env) => {
    calls.push({ binary, args, cwd, deadlineMs, env });
    return Promise.resolve(result);
  };
}

/** A recorded spawn invocation. */
interface SpawnCall {
  binary: string;
  args: string[];
  cwd: string;
  deadlineMs: number;
  env?: Record<string, string>;
}

/** The first recorded spawn; fails the test if none was made. */
function firstCall(calls: SpawnCall[]): SpawnCall {
  const call = calls[0];
  if (call === undefined) throw new Error("expected one spawn call");
  return call;
}

/** A spawner that must never be called. */
const unexpectedSpawn: SpawnFn = () => {
  throw new Error("spawn must not be called on this route");
};

const PIN_KEY = `checkov --version`;
const IMAGE_INSPECT_KEY = `docker image inspect ${CHECKOV_IMAGE}`;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("buildCheckovContainerArgs - mounts read-only and keeps --entrypoint checkov", () => {
  const args = buildCheckovContainerArgs("/repo");
  assertEquals(args.slice(0, 3), ["run", "--rm", "-v"]);
  assertEquals(args[3], "/repo:/src:ro");
  assertStringIncludes(args.join(" "), "--entrypoint checkov");
  assert(
    args.includes(CHECKOV_IMAGE),
    "container args must name the pinned image",
  );
  assertEquals(args.slice(-CHECKOV_SCAN_ARGS.length), [...CHECKOV_SCAN_ARGS]);
});

Deno.test("checkovTemplateReader - returns null for a missing file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const read = checkovTemplateReader(dir);
    assertEquals(await read("absent.yaml"), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkovTemplateReader - rethrows a read fault other than NotFound", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/a-directory.yaml`);
    const read = checkovTemplateReader(dir);
    let threw = false;
    try {
      await read("a-directory.yaml");
    } catch {
      threw = true;
    }
    assert(threw, "reading a directory must rethrow, not return null");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Route selection
// ---------------------------------------------------------------------------

Deno.test("runCheckovCheck - a PATH checkov on the pin is used with the CI scan args", async () => {
  const spawnCalls: SpawnCall[] = [];
  const result = await runCheckovCheck("/repo", {
    probe: fakeProbe({ [PIN_KEY]: `${CHECKOV_IMAGE_TAG}\n` }),
    spawn: fakeSpawn(
      { exitCode: 0, stdout: await report("clean"), stderr: "" },
      spawnCalls,
    ),
  });
  assertEquals(result.status, "PASSED");
  assertEquals(spawnCalls.length, 1);
  assertEquals(firstCall(spawnCalls).binary, "checkov");
  assertEquals(firstCall(spawnCalls).args, [...CHECKOV_SCAN_ARGS]);
  assertEquals(firstCall(spawnCalls).cwd, "/repo");
  assertEquals(firstCall(spawnCalls).deadlineMs, CHECKOV_DEADLINE_MS);
});

Deno.test("runCheckovCheck - the PATH route runs with no CKV_, BC_ or PRISMA_ variable and an empty private HOME", async () => {
  const hostile: Record<string, string> = {
    CKV_SKIP_CHECK: "CKV_AWS_158",
    CKV_CHECK: "CKV_AWS_1",
    CKV_LOG_LEVEL: "DEBUG",
    BC_API_KEY: "not-a-real-key",
    BC_SKIP_MAPPING: "TRUE",
    PRISMA_API_URL: "https://example.invalid",
  };
  const saved = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(hostile)) {
    saved.set(name, Deno.env.get(name));
    Deno.env.set(name, value);
  }
  const callerHome = Deno.env.get("HOME");
  let homeDuring: string | undefined;
  const homeEntries: string[] = [];
  const spawnCalls: SpawnCall[] = [];
  const spawn: SpawnFn = async (binary, args, cwd, deadlineMs, env) => {
    homeDuring = env?.HOME;
    if (homeDuring !== undefined) {
      for await (const entry of Deno.readDir(homeDuring)) {
        homeEntries.push(entry.name);
      }
    }
    return await fakeSpawn(
      { exitCode: 0, stdout: await report("clean"), stderr: "" },
      spawnCalls,
    )(binary, args, cwd, deadlineMs, env);
  };
  try {
    const result = await runCheckovCheck("/repo", {
      probe: fakeProbe({ [PIN_KEY]: CHECKOV_IMAGE_TAG }),
      spawn,
    });
    assertEquals(result.status, "PASSED");
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }

  const env = firstCall(spawnCalls).env;
  assert(env !== undefined, "the PATH route must pass a built environment");
  const leaked = Object.keys(env).filter((name) =>
    /^(CKV_|BC_|PRISMA_)/.test(name)
  );
  assertEquals(leaked, []);
  assert(env.PATH !== undefined, "the child must still find tools on PATH");
  assert(homeDuring !== undefined, "HOME must be set for the child");
  assert(homeDuring !== callerHome, "HOME must not be the caller's own");
  assertEquals(homeEntries, [], "the private HOME must start empty");
  let homeStillThere = true;
  try {
    await Deno.stat(homeDuring);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    homeStillThere = false;
  }
  assert(!homeStillThere, "the private HOME must be removed after the scan");
});

Deno.test("spawnWithDeadline - a given env is the child's whole environment, and none inherits", async () => {
  const name = "CKV_SPAWN_TEST_ONLY";
  const before = Deno.env.get(name);
  Deno.env.set(name, "inherited");
  try {
    const inherited = await spawnWithDeadline("env", [], ".", 10_000);
    assertStringIncludes(inherited.stdout, `${name}=inherited`);

    const built = await spawnWithDeadline("env", [], ".", 10_000, {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      KEPT: "yes",
    });
    assertStringIncludes(built.stdout, "KEPT=yes");
    assert(!built.stdout.includes(name), "the caller's variable leaked");
  } finally {
    if (before === undefined) Deno.env.delete(name);
    else Deno.env.set(name, before);
  }
});

Deno.test("runCheckovCheck - the container route passes no environment of its own", async () => {
  const spawnCalls: SpawnCall[] = [];
  await runCheckovCheck("/repo", {
    probe: fakeProbe({ [IMAGE_INSPECT_KEY]: "[]" }),
    spawn: fakeSpawn(
      { exitCode: 0, stdout: await report("clean"), stderr: "" },
      spawnCalls,
    ),
  });
  assertEquals(firstCall(spawnCalls).binary, "docker");
  assertEquals(firstCall(spawnCalls).env, undefined);
});

for (const name of [".checkov.yaml", ".checkov.yml"]) {
  Deno.test(`runCheckovCheck - ${name} in the scanned directory is FAILED before any route is tried`, async () => {
    const dir = await Deno.makeTempDir({ prefix: "checkov-root-" });
    try {
      // Positive control: with no config file and no route, the stage SKIPs.
      const control = await runCheckovCheck(dir, {
        probe: fakeProbe({}),
        spawn: unexpectedSpawn,
      });
      assertEquals(control.status, "SKIPPED");

      await Deno.writeTextFile(`${dir}/${name}`, "skip-check: [CKV_AWS_158]");
      const probeCalls: string[][] = [];
      const result = await runCheckovCheck(dir, {
        probe: fakeProbe({ [PIN_KEY]: CHECKOV_IMAGE_TAG }, probeCalls),
        spawn: unexpectedSpawn,
      });
      assertEquals(result.status, "FAILED");
      assertStringIncludes(result.output, `${name} is present`);
      assertStringIncludes(result.output, "Status: FAILED");
      assertEquals(probeCalls, [], "no route may be probed or run");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
}

Deno.test("runCheckovCheck - a PATH version mismatch is not run and falls through to SKIPPED", async () => {
  const result = await runCheckovCheck("/repo", {
    probe: fakeProbe({ [PIN_KEY]: "2.0.0" }),
    spawn: unexpectedSpawn,
  });
  assertEquals(result.status, "SKIPPED");
  assertStringIncludes(
    result.skipReason ?? "",
    `checkov on PATH reports 2.0.0, not the CI pin ${CHECKOV_IMAGE_TAG}`,
  );
  assertStringIncludes(result.output, "SKIPPED");
});

Deno.test("runCheckovCheck - an empty --version output is SKIPPED as an unknown version", async () => {
  const result = await runCheckovCheck("/repo", {
    probe: fakeProbe({ [PIN_KEY]: "" }),
    spawn: unexpectedSpawn,
  });
  assertEquals(result.status, "SKIPPED");
  assertStringIncludes(result.output, "an unknown version");
});

Deno.test("runCheckovCheck - a PATH version mismatch still reaches the docker route", async () => {
  const spawnCalls: SpawnCall[] = [];
  const result = await runCheckovCheck("/repo", {
    probe: fakeProbe({
      [PIN_KEY]: "2.0.0",
      [IMAGE_INSPECT_KEY]: "[]",
    }),
    spawn: fakeSpawn(
      { exitCode: 0, stdout: await report("clean"), stderr: "" },
      spawnCalls,
    ),
  });
  assertEquals(result.status, "PASSED");
  assertEquals(firstCall(spawnCalls).binary, "docker");
  assertEquals(firstCall(spawnCalls).args, buildCheckovContainerArgs("/repo"));
});

Deno.test("runCheckovCheck - a docker-held image runs read-only via --entrypoint checkov", async () => {
  const spawnCalls: SpawnCall[] = [];
  const probeCalls: string[][] = [];
  await runCheckovCheck("/repo", {
    probe: fakeProbe({
      [IMAGE_INSPECT_KEY]: "[]",
    }, probeCalls),
    spawn: fakeSpawn(
      { exitCode: 0, stdout: await report("clean"), stderr: "" },
      spawnCalls,
    ),
  });
  const args = firstCall(spawnCalls).args;
  assertStringIncludes(args.join(" "), "/repo:/src:ro");
  assertStringIncludes(args.join(" "), "--entrypoint checkov");
  assertEquals(firstCall(spawnCalls).deadlineMs, CHECKOV_DEADLINE_MS);
  assert(
    probeCalls.every((call) => !call.includes("pull")),
    `the stage must never pull an image; probes: ${JSON.stringify(probeCalls)}`,
  );
});

Deno.test("runCheckovCheck - podman is used when docker is absent and podman holds the image", async () => {
  const spawnCalls: SpawnCall[] = [];
  await runCheckovCheck("/repo", {
    probe: fakeProbe({
      [`podman image inspect ${CHECKOV_IMAGE}`]: "[]",
    }),
    spawn: fakeSpawn(
      { exitCode: 0, stdout: await report("clean"), stderr: "" },
      spawnCalls,
    ),
  });
  assertEquals(firstCall(spawnCalls).binary, "podman");
});

Deno.test("runCheckovCheck - a runtime without the image is not used and is SKIPPED", async () => {
  const result = await runCheckovCheck("/repo", {
    probe: fakeProbe({}),
    spawn: unexpectedSpawn,
  });
  assertEquals(result.status, "SKIPPED");
  assertStringIncludes(
    result.skipReason ?? "",
    `no docker or podman holding ${CHECKOV_IMAGE}`,
  );
});

Deno.test("runCheckovCheck - SKIPPED names every unusable route and the install hint", async () => {
  const probeCalls: string[][] = [];
  const result = await runCheckovCheck("/repo", {
    probe: fakeProbe({}, probeCalls),
    spawn: unexpectedSpawn,
  });
  assertEquals(result.status, "SKIPPED");
  assertStringIncludes(result.output, "no checkov on PATH");
  assertStringIncludes(
    result.output,
    `no docker or podman holding ${CHECKOV_IMAGE}`,
  );
  assertStringIncludes(
    result.output,
    `pipx install checkov==${CHECKOV_IMAGE_TAG}`,
  );
  assert(
    probeCalls.every((call) => !call.includes("pull")),
    `the stage must never pull an image; probes: ${JSON.stringify(probeCalls)}`,
  );
});

Deno.test("runCheckovCheck - a SKIPPED checkov fails the gate under --strict", async () => {
  const result = await runCheckovCheck("/repo", {
    probe: fakeProbe({}),
    spawn: unexpectedSpawn,
  });
  assertEquals(result.status, "SKIPPED");
  const checks: CheckResult[] = [];
  recordCheck(checks, "checkov", result.status);
  assertEquals(formatSummary(checks, false).passed, true);
  const strictSummary = formatSummary(checks, true);
  assertEquals(strictSummary.passed, false);
  assertStringIncludes(strictSummary.text, "Result: FAILED");
});

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

Deno.test("runCheckovCheck - a deadline hit is FAILED, not SKIPPED or PASSED", async () => {
  const result = await runCheckovCheck("/repo", {
    probe: fakeProbe({ [PIN_KEY]: CHECKOV_IMAGE_TAG }),
    spawn: fakeSpawn(
      { exitCode: -1, stdout: "", stderr: "", timedOut: true },
      [],
    ),
  });
  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "exceeded");
});

Deno.test("runCheckovCheck - a failing scan is FAILED with the judge's finding", async () => {
  const result = await runCheckovCheck("/repo", {
    probe: fakeProbe({ [PIN_KEY]: CHECKOV_IMAGE_TAG }),
    spawn: fakeSpawn(
      { exitCode: 1, stdout: await report("failed"), stderr: "" },
      [],
    ),
  });
  assertEquals(result.status, "FAILED");
  assertStringIncludes(
    result.output,
    "CKV_AWS_158 failed at /template.yaml lines 3-6",
  );
  assertStringIncludes(result.output, "Status: FAILED");
});

Deno.test("runCheckovCheck - a clean scan is PASSED", async () => {
  const result = await runCheckovCheck("/repo", {
    probe: fakeProbe({ [PIN_KEY]: CHECKOV_IMAGE_TAG }),
    spawn: fakeSpawn(
      { exitCode: 0, stdout: await report("clean"), stderr: "" },
      [],
    ),
  });
  assertEquals(result.status, "PASSED");
});

Deno.test("runCheckovCheck - a FAILED run with non-JSON stdout shows the stderr tail", async () => {
  const result = await runCheckovCheck("/repo", {
    probe: fakeProbe({ [PIN_KEY]: CHECKOV_IMAGE_TAG }),
    spawn: fakeSpawn(
      {
        exitCode: 2,
        stdout: "not json",
        stderr: "boom: image layer missing\n",
      },
      [],
    ),
  });
  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "checkov stderr (last lines):");
  assertStringIncludes(result.output, "boom: image layer missing");
});

Deno.test("runCheckovCheck - the stderr tail redacts a token", async () => {
  const token = ["ghp", "_", "0123456789abcdefghijklmnopqrstuvwxyzAB"].join(
    "",
  );
  const result = await runCheckovCheck("/repo", {
    probe: fakeProbe({ [PIN_KEY]: CHECKOV_IMAGE_TAG }),
    spawn: fakeSpawn(
      {
        exitCode: 2,
        stdout: "not json",
        stderr: `auth failed: ${token}\nboom\n`,
      },
      [],
    ),
  });
  assertEquals(result.status, "FAILED");
  assertStringIncludes(result.output, "boom");
  assert(!result.output.includes(token), "the stderr tail must be redacted");
});

Deno.test("runCheckovCheck - a FAILED run with JSON stdout shows no stderr tail", async () => {
  const result = await runCheckovCheck("/repo", {
    probe: fakeProbe({ [PIN_KEY]: CHECKOV_IMAGE_TAG }),
    spawn: fakeSpawn(
      {
        exitCode: 1,
        stdout: await report("failed"),
        stderr: "some stderr noise\n",
      },
      [],
    ),
  });
  assertEquals(result.status, "FAILED");
  assert(
    !result.output.includes("checkov stderr (last lines):"),
    "a JSON stdout run must not show the stderr tail",
  );
  assert(
    !result.output.includes("some stderr noise"),
    "a JSON stdout run must not echo stderr",
  );
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

Deno.test("runQualityGate - registers checkov only where checkov.yml exists", async () => {
  const withWorkflow = await Deno.makeTempDir();
  const withoutWorkflow = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${withWorkflow}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${withWorkflow}/.github/workflows/checkov.yml`,
      "name: checkov\n",
    );

    const options = { strict: false, sequential: true, validatePrompts: false };

    const present = await runQualityGate({ scriptDir: withWorkflow, options });
    assert(present.ok, "quality gate should return a result");
    const presentNames = present.value.checks.map((check) => check.name);
    assert(
      presentNames.includes("checkov"),
      `Gate must run checkov where checkov.yml exists (Issue #3972); recorded: ${
        presentNames.join(", ")
      }`,
    );

    const absent = await runQualityGate({
      scriptDir: withoutWorkflow,
      options,
    });
    assert(absent.ok, "quality gate should return a result");
    const absentNames = absent.value.checks.map((check) => check.name);
    assert(
      !absentNames.includes("checkov"),
      `Gate must not run checkov where checkov.yml is absent; recorded: ${
        absentNames.join(", ")
      }`,
    );
  } finally {
    await Deno.remove(withWorkflow, { recursive: true });
    await Deno.remove(withoutWorkflow, { recursive: true });
  }
});
