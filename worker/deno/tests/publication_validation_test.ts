/**
 * Tests for runner-owned publication validation (Issue #4625).
 *
 * Each test builds its own temporary git checkout, so nothing depends on a
 * fixed path or on the state of the developer's machine. Gate outcomes are
 * injected through `runGate`, except the tests that run the real
 * `runQualityGateCheck` against a committed `quality.sh`.
 */

import {
  assertEquals,
  assertInstanceOf,
  assertStringIncludes,
} from "@std/assert";
import type { RepoConfig, Result } from "../types.ts";
import {
  createPublicationGuard,
  PUBLICATION_GATE_TIMEOUT_SECONDS,
  type PublicationValidation,
  PublicationValidationFailedError,
  PublicationValidationUnavailableError,
  publicationVerdict,
  validateRepositoryForPublication,
} from "../lib/publication_validation.ts";
import { PrePushGateInfrastructureError } from "../lib/pre_push_gate.ts";
import {
  createDefaultDeps,
  type QualityGateDeps,
  type QualityGateParams,
  type QualityGateRunResult,
  runQualityGateCheck,
} from "../lib/quality_gate_phase.ts";

const REPO = "acme/widget";
const decoder = new TextDecoder();

type GateCall = { params: QualityGateParams; deps: QualityGateDeps };

const PASS: QualityGateRunResult = { action: "passed", qualityOutput: "" };

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${decoder.decode(result.stderr)}`,
    );
  }
  return decoder.decode(result.stdout).trim();
}

/**
 * Runs `fn` in a fresh git checkout holding one commit of `files`. Files whose
 * name ends in `.sh` are committed executable. The checkout is removed after.
 */
async function withRepo(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "publication-validation-" });
  try {
    // The gate runs the repository's own commands as the untrusted `agent`
    // account where the host has one, and that account must be able to reach
    // the checkout, as it can in production. A makeTempDir directory is 0700.
    await Deno.chmod(dir, 0o755);
    await git(dir, "init", "--quiet", "--initial-branch=main");
    await git(dir, "config", "user.email", "test@example.invalid");
    await git(dir, "config", "user.name", "Test");
    await git(dir, "config", "commit.gpgsign", "false");
    for (const [path, body] of Object.entries(files)) {
      await Deno.writeTextFile(`${dir}/${path}`, body);
      if (path.endsWith(".sh")) await Deno.chmod(`${dir}/${path}`, 0o755);
    }
    await git(dir, "add", "-A");
    await git(dir, "commit", "--quiet", "-m", "initial");
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** A `runGate` seam that records its calls and returns `result`. */
function stubGate(result: QualityGateRunResult, calls: GateCall[] = []) {
  return (
    params: QualityGateParams,
    deps: QualityGateDeps,
  ): Promise<QualityGateRunResult> => {
    calls.push({ params, deps });
    return Promise.resolve(result);
  };
}

/**
 * The real `runQualityGateCheck`, with the port and process sweeps replaced by
 * no-ops: the production sweeps kill whatever listens on the dev-server ports,
 * which a test must never do on a developer's machine.
 */
function realGate(
  params: QualityGateParams,
  deps: QualityGateDeps,
): Promise<QualityGateRunResult> {
  return runQualityGateCheck(params, {
    ...deps,
    cleanupPorts: () => Promise.resolve(),
    cleanupSubprocesses: () => Promise.resolve(),
  });
}

/**
 * A `createDeps` seam whose base `runCommand` returns `result` without
 * spawning anything, so a test can choose the exit code the gate reports.
 */
function baseReturning(
  result: { exitCode: number; output: string },
): (env: Record<string, string>) => QualityGateDeps {
  return () => ({
    ...createDefaultDeps(),
    runCommand: () => Promise.resolve(result),
  });
}

/** A `runGate` seam that runs one command through its deps, then returns `result`. */
function gateRunning(
  result: QualityGateRunResult,
): (
  params: QualityGateParams,
  deps: QualityGateDeps,
) => Promise<QualityGateRunResult> {
  return async (_params, deps) => {
    await deps.runCommand(["true"], { stdin: "null" });
    return result;
  };
}

/** Narrows a validation to the status the test expects, or fails the test. */
function expectStatus<S extends PublicationValidation["status"]>(
  validation: PublicationValidation,
  status: S,
): Extract<PublicationValidation, { status: S }> {
  if (validation.status !== status) {
    throw new Error(
      `expected ${status}, got ${JSON.stringify(validation)}`,
    );
  }
  return validation as Extract<PublicationValidation, { status: S }>;
}

function firstCall(calls: GateCall[]): GateCall {
  const call = calls[0];
  if (!call) throw new Error("the gate was not called");
  return call;
}

function errorOf(result: Result<void>): Error {
  if (result.ok) throw new Error("expected an error result");
  return result.error;
}

Deno.test("each gate action maps to its publication verdict", async (t) => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    const head = await git(dir, "rev-parse", "HEAD");
    const run = (result: QualityGateRunResult) =>
      validateRepositoryForPublication(
        { cwd: dir, repo: REPO },
        { runGate: stubGate(result) },
      );

    await t.step("passed publishes as ran", async () => {
      const v = expectStatus(
        await run({ action: "passed", qualityOutput: "all green" }),
        "passed",
      );
      assertEquals(v.gate, "ran");
      assertEquals(v.head, head);
    });

    await t.step("skipped publishes as absent", async () => {
      const v = expectStatus(
        await run({ action: "skipped", qualityOutput: "" }),
        "passed",
      );
      assertEquals(v.gate, "absent");
    });

    await t.step("failed_fixable is failed with its output", async () => {
      const v = expectStatus(
        await run({
          action: "failed_fixable",
          qualityOutput: "SENTINEL-FIXABLE",
        }),
        "failed",
      );
      assertStringIncludes(v.output, "SENTINEL-FIXABLE");
      assertEquals(v.head, head);
    });

    await t.step("failed is failed with its output", async () => {
      const v = expectStatus(
        await run({ action: "failed", qualityOutput: "SENTINEL-FAILED" }),
        "failed",
      );
      assertStringIncludes(v.output, "SENTINEL-FAILED");
    });

    const infrastructure = [
      "failed_missing_tools",
      "failed_missing_command",
      "failed_docker_infra",
      "failed_credential_delivery",
    ] as const;
    for (const action of infrastructure) {
      await t.step(`${action} is unavailable, not a verdict`, async () => {
        const v = expectStatus(
          await run({ action, qualityOutput: `SENTINEL ${action}` }),
          "unavailable",
        );
        assertStringIncludes(v.reason, `SENTINEL ${action}`);
        assertEquals(v.head, head);
      });
    }
  });
});

Deno.test("a Deno run that executed no tests is not a pass", async (t) => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    const run = (qualityOutput: string) =>
      validateRepositoryForPublication(
        { cwd: dir, repo: REPO },
        { runGate: stubGate({ action: "passed", qualityOutput }) },
      );

    await t.step("0 passed, 0 failed is failed", async () => {
      const v = expectStatus(await run("ok | 0 passed | 0 failed"), "failed");
      assertStringIncludes(v.output, "executed no tests");
    });

    await t.step("12 tests across 3 steps passes", async () => {
      const v = expectStatus(
        await run("ok | 12 passed (3 steps) | 0 failed"),
        "passed",
      );
      assertEquals(v.gate, "ran");
    });
  });
});

Deno.test("uncommitted changes fail the check, except worker state files", async (t) => {
  await t.step("a modified tracked file is named", async () => {
    await withRepo({ "README.md": "hello\n" }, async (dir) => {
      await Deno.writeTextFile(`${dir}/README.md`, "edited\n");
      const calls: GateCall[] = [];
      const v = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO },
          { runGate: stubGate(PASS, calls) },
        ),
        "failed",
      );
      assertStringIncludes(v.output, "README.md");
      assertEquals(calls.length, 0);
    });
  });

  await t.step("an untracked file is named", async () => {
    await withRepo({ "README.md": "hello\n" }, async (dir) => {
      await Deno.writeTextFile(`${dir}/notes.txt`, "scratch\n");
      const v = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO },
          { runGate: stubGate(PASS) },
        ),
        "failed",
      );
      assertStringIncludes(v.output, "notes.txt");
    });
  });

  await t.step("an untracked .pr_response_message is ignored", async () => {
    await withRepo({ "README.md": "hello\n" }, async (dir) => {
      await Deno.writeTextFile(`${dir}/.pr_response_message`, "reply\n");
      const calls: GateCall[] = [];
      const v = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO },
          { runGate: stubGate(PASS, calls) },
        ),
        "passed",
      );
      assertEquals(v.gate, "ran");
      assertEquals(calls.length, 1);
    });
  });
});

Deno.test("a gate that moves HEAD makes the result unavailable", async () => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    const v = expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO },
        {
          runGate: async () => {
            await git(dir, "commit", "--allow-empty", "--quiet", "-m", "moved");
            return PASS;
          },
        },
      ),
      "unavailable",
    );
    assertStringIncludes(v.reason, "HEAD moved");
  });
});

Deno.test("an opted-out repository passes without running the gate", async () => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    const calls: GateCall[] = [];
    const repoConfigs: Record<string, RepoConfig> = {
      [REPO]: { skipQualityCheck: true },
    };
    const v = expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO, repoConfigs },
        { runGate: stubGate(PASS, calls) },
      ),
      "passed",
    );
    assertEquals(v.gate, "opted-out");
    assertEquals(calls.length, 0);
  });
});

Deno.test("the repository's qualityCommand is the gate script", async (t) => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    await t.step("a configured command is passed through", async () => {
      const calls: GateCall[] = [];
      const repoConfigs: Record<string, RepoConfig> = {
        [REPO]: { qualityCommand: "./scripts/check.sh" },
      };
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO, repoConfigs },
        { runGate: stubGate(PASS, calls) },
      );
      assertEquals(firstCall(calls).params.qualityScript, "./scripts/check.sh");
      assertEquals(firstCall(calls).params.repo, REPO);
    });

    await t.step("the default is ./quality.sh", async () => {
      const calls: GateCall[] = [];
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO },
        { runGate: stubGate(PASS, calls) },
      );
      assertEquals(firstCall(calls).params.qualityScript, "./quality.sh");
    });
  });
});

Deno.test("the gate gets the 30-minute publication timeout", async () => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    const calls: GateCall[] = [];
    const repoConfigs: Record<string, RepoConfig> = {
      [REPO]: { qualityCheckTimeout: 5 },
    };
    await validateRepositoryForPublication(
      { cwd: dir, repo: REPO, repoConfigs },
      { runGate: stubGate(PASS, calls) },
    );
    const params = firstCall(calls).params;
    assertEquals(params.defaultTimeoutSeconds, 1800);
    assertEquals(PUBLICATION_GATE_TIMEOUT_SECONDS, 1800);
    // The repository's own timeout still rides along and overrides the default.
    assertEquals(params.repoConfigs?.[REPO]?.qualityCheckTimeout, 5);
  });
});

Deno.test("the gate's deps are bound to the checkout", async (t) => {
  await t.step("a committed quality.sh is found in the checkout", async () => {
    await withRepo({ "quality.sh": "#!/bin/sh\nexit 0\n" }, async (dir) => {
      const calls: GateCall[] = [];
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO },
        { runGate: stubGate(PASS, calls) },
      );
      const deps = firstCall(calls).deps;
      assertEquals(deps.getCwd(), dir);
      assertEquals(await deps.fileExists("./quality.sh"), true);
    });
  });

  await t.step("a checkout without quality.sh does not find one", async () => {
    await withRepo({ "README.md": "hello\n" }, async (dir) => {
      const calls: GateCall[] = [];
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO },
        { runGate: stubGate(PASS, calls) },
      );
      assertEquals(
        await firstCall(calls).deps.fileExists("./quality.sh"),
        false,
      );
    });
  });
});

Deno.test("a directory that is not a git checkout is unavailable", async () => {
  const dir = await Deno.makeTempDir({
    prefix: "publication-validation-nogit-",
  });
  try {
    const calls: GateCall[] = [];
    const v = expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO },
        { runGate: stubGate(PASS, calls) },
      ),
      "unavailable",
    );
    assertEquals(v.head, null);
    assertEquals(calls.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("publicationVerdict turns each status into the matching Result", () => {
  const failed = publicationVerdict({
    status: "failed",
    head: "abc",
    output: "SENTINEL-VERDICT",
  });
  assertEquals(failed.ok, false);
  const failure = errorOf(failed);
  assertInstanceOf(failure, PublicationValidationFailedError);
  assertStringIncludes(failure.message, "SENTINEL-VERDICT");

  const unavailable = publicationVerdict({
    status: "unavailable",
    head: "abc",
    reason: "SENTINEL-REASON",
  });
  assertEquals(unavailable.ok, false);
  const outage = errorOf(unavailable);
  assertInstanceOf(outage, PublicationValidationUnavailableError);
  assertInstanceOf(outage, PrePushGateInfrastructureError);
  assertStringIncludes(outage.message, "SENTINEL-REASON");

  assertEquals(
    publicationVerdict({ status: "passed", head: "abc", gate: "ran" }),
    { ok: true, value: undefined },
  );
});

Deno.test("the real quality gate: a failing quality.sh is a failed verdict", async () => {
  await withRepo(
    { "quality.sh": "#!/bin/sh\necho boom\nexit 1\n" },
    async (dir) => {
      const v = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO },
          { runGate: realGate },
        ),
        "failed",
      );
      assertStringIncludes(v.output, "boom");
    },
  );
});

Deno.test("the real quality gate: a passing quality.sh publishes as ran", async () => {
  await withRepo(
    { "quality.sh": "#!/bin/sh\necho all clear\nexit 0\n" },
    async (dir) => {
      const v = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO },
          { runGate: realGate },
        ),
        "passed",
      );
      assertEquals(v.gate, "ran");
    },
  );
});

Deno.test("the real quality gate: exit 124 is unavailable, naming the timeout", async () => {
  await withRepo(
    { "quality.sh": "#!/bin/sh\necho slow\nexit 124\n" },
    async (dir) => {
      const v = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO },
          { runGate: realGate },
        ),
        "unavailable",
      );
      assertStringIncludes(v.reason, "timed out (exit 124)");
    },
  );
});

Deno.test("the real quality gate: a full disk is unavailable, naming the disk", async () => {
  await withRepo(
    {
      "quality.sh":
        "#!/bin/sh\necho 'write failed: No space left on device' >&2\nexit 1\n",
    },
    async (dir) => {
      const v = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO },
          { runGate: realGate },
        ),
        "unavailable",
      );
      assertStringIncludes(v.reason, "ran out of disk");
      assertStringIncludes(v.reason, "No space left on device");
    },
  );
});

Deno.test("the real quality gate: ordinary failures stay failed", async (t) => {
  await t.step("a test failure with exit 1 is failed", async () => {
    await withRepo(
      { "quality.sh": "#!/bin/sh\necho '1 test failed'\nexit 1\n" },
      async (dir) => {
        const v = expectStatus(
          await validateRepositoryForPublication(
            { cwd: dir, repo: REPO },
            { runGate: realGate },
          ),
          "failed",
        );
        assertStringIncludes(v.output, "1 test failed");
      },
    );
  });

  await t.step(
    "a failure that merely mentions a timeout is failed",
    async () => {
      await withRepo(
        {
          "quality.sh":
            "#!/bin/sh\necho 'timeout waiting for the fixture server'\nexit 1\n",
        },
        async (dir) => {
          const v = expectStatus(
            await validateRepositoryForPublication(
              { cwd: dir, repo: REPO },
              { runGate: realGate },
            ),
            "failed",
          );
          assertStringIncludes(v.output, "timeout waiting");
        },
      );
    },
  );
});

Deno.test("a gate killed by its timeout is unavailable, whatever its output", async (t) => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    for (const exitCode of [124, 137, 143]) {
      await t.step(`exit ${exitCode} is unavailable`, async () => {
        const v = expectStatus(
          await validateRepositoryForPublication(
            { cwd: dir, repo: REPO },
            {
              createDeps: baseReturning({ exitCode, output: "partial" }),
              runGate: gateRunning({
                action: "failed_fixable",
                qualityOutput: "partial",
              }),
            },
          ),
          "unavailable",
        );
        assertStringIncludes(v.reason, `timed out (exit ${exitCode})`);
      });
    }

    await t.step("a passed gate stays passed despite the code", async () => {
      const v = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO },
          {
            createDeps: baseReturning({ exitCode: 124, output: "" }),
            runGate: gateRunning(PASS),
          },
        ),
        "passed",
      );
      assertEquals(v.gate, "ran");
    });
  });
});

Deno.test("a failed gate whose output reports a full disk is unavailable", async (t) => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    for (
      const line of [
        "No space left on device",
        "open failed: ENOSPC",
        "write: disk quota exceeded",
      ]
    ) {
      await t.step(`"${line}" is unavailable`, async () => {
        const v = expectStatus(
          await validateRepositoryForPublication(
            { cwd: dir, repo: REPO },
            {
              runGate: stubGate({
                action: "failed",
                qualityOutput: `build step\n${line}\n`,
              }),
            },
          ),
          "unavailable",
        );
        assertStringIncludes(v.reason, "ran out of disk");
        assertStringIncludes(v.reason, line);
      });
    }
  });
});

Deno.test("the gate's runCommand returns its result unchanged in the checkout", async () => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    const seenCwd: string[] = [];
    let returned: { exitCode: number; output: string } | undefined;
    await validateRepositoryForPublication(
      { cwd: dir, repo: REPO },
      {
        createDeps: () => ({
          ...createDefaultDeps(),
          runCommand: (_cmd, options) => {
            seenCwd.push(options?.cwd ?? "");
            return Promise.resolve({ exitCode: 0, output: "all clear" });
          },
        }),
        runGate: async (_params, deps) => {
          returned = await deps.runCommand(["true"], { stdin: "null" });
          return PASS;
        },
      },
    );
    assertEquals(returned, { exitCode: 0, output: "all clear" });
    assertEquals(seenCwd, [dir]);
  });
});

Deno.test("a checkout that cannot be re-read after the checks is unavailable", async () => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    const v = expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO },
        {
          runGate: async () => {
            await Deno.remove(`${dir}/.git`, { recursive: true });
            return PASS;
          },
        },
      ),
      "unavailable",
    );
    assertStringIncludes(v.reason, "could not re-read");
    assertEquals(v.reason.includes("HEAD moved"), false);
  });
});

Deno.test("the guard validates a new head once and reuses a clean pass", async () => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    const head = await git(dir, "rev-parse", "HEAD");
    const passedVerdict: PublicationValidation = {
      status: "passed",
      head,
      gate: "ran",
    };
    let validations = 0;
    const guard = createPublicationGuard({
      cwd: dir,
      repo: REPO,
      branchName: "main",
      validate: () => {
        validations++;
        return Promise.resolve(passedVerdict);
      },
    });
    assertEquals((await guard()).ok, true);
    assertEquals((await guard()).ok, true);
    assertEquals(validations, 1);
  });
});

Deno.test("the guard validates a new commit afresh", async () => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    let validations = 0;
    const guard = createPublicationGuard({
      cwd: dir,
      repo: REPO,
      branchName: "main",
      validate: async () => {
        validations++;
        const head = await git(dir, "rev-parse", "HEAD");
        return { status: "passed", head, gate: "ran" };
      },
    });
    assertEquals((await guard()).ok, true);
    await git(dir, "commit", "--allow-empty", "--quiet", "-m", "second");
    assertEquals((await guard()).ok, true);
    assertEquals(validations, 2);
  });
});

Deno.test("the guard re-validates after an uncommitted edit and fails it", async () => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    const calls: GateCall[] = [];
    const guard = createPublicationGuard({
      cwd: dir,
      repo: REPO,
      branchName: "main",
      validate: (options) =>
        validateRepositoryForPublication(options, {
          runGate: stubGate(PASS, calls),
        }),
    });
    assertEquals((await guard()).ok, true);
    assertEquals(calls.length, 1);

    await Deno.writeTextFile(`${dir}/README.md`, "edited\n");
    const verdict = await guard();
    assertEquals(verdict.ok, false);
    const error = errorOf(verdict);
    assertInstanceOf(error, PublicationValidationFailedError);
    assertStringIncludes(error.message, "README.md");
    assertEquals(calls.length, 1);
  });
});

Deno.test("the guard returns the failed output as an error", async () => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    const guard = createPublicationGuard({
      cwd: dir,
      repo: REPO,
      branchName: "main",
      validate: () =>
        Promise.resolve({
          status: "failed",
          head: null,
          output: "SENTINEL-GUARD-OUTPUT",
        }),
    });
    const verdict = await guard();
    assertEquals(verdict.ok, false);
    const error = errorOf(verdict);
    assertInstanceOf(error, PublicationValidationFailedError);
    assertStringIncludes(error.message, "SENTINEL-GUARD-OUTPUT");
  });
});

Deno.test("the guard does not validate a branch in sync with its remote", async () => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    const origin = await Deno.makeTempDir({
      prefix: "publication-validation-origin-",
    });
    try {
      await git(origin, "init", "--quiet", "--bare");
      await git(dir, "remote", "add", "origin", origin);
      await git(dir, "push", "--quiet", "-u", "origin", "main");

      let validations = 0;
      const guard = createPublicationGuard({
        cwd: dir,
        repo: REPO,
        branchName: "main",
        validate: () => {
          validations++;
          return Promise.resolve({
            status: "passed",
            head: "unused",
            gate: "ran",
          });
        },
      });
      assertEquals((await guard()).ok, true);
      assertEquals(validations, 0);
    } finally {
      await Deno.remove(origin, { recursive: true });
    }
  });
});

/** A `quality.sh` that runs the repository's Deno tests, as CI compiles them. */
const DENO_QUALITY_SH = "#!/bin/sh\nset -e\ndeno test --no-lock --quiet .\n";

const PASSING_DENO_TEST =
  'Deno.test("ok", () => { if (1 + 1 !== 2) throw new Error("math"); });\n';

Deno.test("the real quality gate: a test module that does not compile is a failed verdict, naming the compile error", async () => {
  await withRepo(
    {
      "quality.sh": DENO_QUALITY_SH,
      "broken_test.ts":
        'const count: number = "not a number";\nDeno.test("never runs", () => { console.log(count); });\n',
    },
    async (dir) => {
      const v = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO },
          { runGate: realGate },
        ),
        "failed",
      );
      assertStringIncludes(v.output, "TS2322");
    },
  );
});

Deno.test("the real quality gate: Deno tests run in the initial run and again in the repair", async () => {
  await withRepo(
    {
      "quality.sh": DENO_QUALITY_SH,
      "fix_test.ts":
        'Deno.test("needs the fix", () => { throw new Error("SENTINEL-INITIAL-FAILURE"); });\n',
    },
    async (dir) => {
      // The initial run executes the test and reports its failure.
      const initial = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO },
          { runGate: realGate },
        ),
        "failed",
      );
      assertStringIncludes(initial.output, "SENTINEL-INITIAL-FAILURE");

      // The repair commits a fix, and the same entry point runs the tests
      // again on the new head.
      await Deno.writeTextFile(`${dir}/fix_test.ts`, PASSING_DENO_TEST);
      await git(dir, "commit", "--quiet", "-am", "repair");
      const repaired = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO },
          { runGate: realGate },
        ),
        "passed",
      );
      assertEquals(repaired.gate, "ran");
      assertEquals(repaired.head, await git(dir, "rev-parse", "HEAD"));
    },
  );
});
