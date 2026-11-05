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
  _resetBaseGateOutcomes,
  createPublicationGuard,
  failureEvidenceLines,
  probePublicationCapability,
  PUBLICATION_GATE_TIMEOUT_SECONDS,
  type PublicationValidation,
  PublicationValidationFailedError,
  PublicationValidationUnavailableError,
  publicationVerdict,
  validateRepositoryForPublication,
} from "../lib/publication_validation.ts";
import { canRunAsUntrustedUser } from "../lib/untrusted_command_env.ts";
import { PrePushGateInfrastructureError } from "../lib/pre_push_gate.ts";
import {
  createDefaultDeps,
  type QualityGateDeps,
  type QualityGateParams,
  type QualityGateRunResult,
  runQualityGateCheck,
  SeparateAccountRequiredError,
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

Deno.test("the real quality gate: exit 124 is failed, naming the timeout", async () => {
  await withRepo(
    { "quality.sh": "#!/bin/sh\necho slow\nexit 124\n" },
    async (dir) => {
      const v = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO },
          { runGate: realGate },
        ),
        "failed",
      );
      assertStringIncludes(v.output, "timed out (exit 124)");
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

// ShellCheck is installed in the worker image; the tests skip where it is not.
const SHELLCHECK_PRESENT = await new Deno.Command("shellcheck", {
  args: ["--version"],
  stdin: "null",
  stdout: "null",
  stderr: "null",
}).output().then((o) => o.success, () => false);

Deno.test({
  name:
    "the real quality gate: a ShellCheck diagnostic from quality.sh is a failed verdict (Issue #4741)",
  ignore: !SHELLCHECK_PRESENT,
  fn: async (t) => {
    const qualityScript = "#!/bin/bash\nset -euo pipefail\nshellcheck bad.sh\n";

    await t.step(
      "a script with SC2086 fails, naming the diagnostic",
      async () => {
        await withRepo(
          {
            "quality.sh": qualityScript,
            "bad.sh": "#!/bin/bash\nname=$1\necho $name\n",
          },
          async (dir) => {
            const v = expectStatus(
              await validateRepositoryForPublication(
                { cwd: dir, repo: REPO },
                { runGate: realGate },
              ),
              "failed",
            );
            assertStringIncludes(v.output, "SC2086");
          },
        );
      },
    );

    await t.step("the same gate passes once the script is clean", async () => {
      await withRepo(
        {
          "quality.sh": qualityScript,
          "bad.sh": '#!/bin/bash\nname=$1\necho "$name"\n',
        },
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
  },
});

Deno.test({
  name:
    "the real quality gate: a gate whose ShellCheck is not installed is unavailable, never a pass (Issue #4741)",
  ignore: false,
  fn: async () => {
    await withRepo(
      {
        "quality.sh": "#!/bin/bash\nPATH=/nonexistent\nshellcheck clean.sh\n",
        "clean.sh": "#!/bin/bash\necho ok\n",
      },
      async (dir) => {
        const v = expectStatus(
          await validateRepositoryForPublication(
            { cwd: dir, repo: REPO },
            { runGate: realGate },
          ),
          "unavailable",
        );
        assertStringIncludes(v.reason, "failed_missing_command");
      },
    );
  },
});

// Issue #4829: a failing test that quotes "command not found" inside Deno's
// captured output block is a failed verdict. Only a shell's own report makes
// the gate unavailable.
Deno.test(
  'the real quality gate: a failing gate whose output quotes "command not found" is a failed verdict, not unavailable (Issue #4829)',
  async (t) => {
    await t.step("the quoted text alone is failed", async () => {
      const quotingScript = [
        "#!/bin/sh",
        "printf '%s\\n' '------- output -------' 'foo: command not found' '----- output end -----' 'launcher test ... ok (1ms)' 'other test ... FAILED (1ms)'",
        "exit 1",
        "",
      ].join("\n");
      await withRepo({ "quality.sh": quotingScript }, async (dir) => {
        const v = expectStatus(
          await validateRepositoryForPublication(
            { cwd: dir, repo: REPO },
            { runGate: realGate },
          ),
          "failed",
        );
        assertStringIncludes(v.output, "other test ... FAILED");
      });
    });

    await t.step(
      "a real shell report remains unavailable when a wrapper exits 1",
      async () => {
        const wrapperScript = [
          "#!/bin/bash",
          "bash -c 'definitely-missing-tool-4829' 2>&1",
          "exit 1",
          "",
        ].join("\n");
        await withRepo({ "quality.sh": wrapperScript }, async (dir) => {
          const v = expectStatus(
            await validateRepositoryForPublication(
              { cwd: dir, repo: REPO },
              { runGate: realGate },
            ),
            "unavailable",
          );
          assertStringIncludes(v.reason, "failed_missing_command");
          assertStringIncludes(v.reason, "command not found");
        });
      },
    );

    await t.step("a real missing command is still unavailable", async () => {
      await withRepo(
        {
          "quality.sh":
            "#!/bin/bash\nPATH=/nonexistent\ndefinitely-missing-tool\n",
        },
        async (dir) => {
          const v = expectStatus(
            await validateRepositoryForPublication(
              { cwd: dir, repo: REPO },
              { runGate: realGate },
            ),
            "unavailable",
          );
          assertStringIncludes(v.reason, "failed_missing_command");
        },
      );
    });
  },
);

Deno.test("the quoted missing-command test output remains eligible for base reproduction", async () => {
  _resetBaseGateOutcomes();
  await withRepo(
    {
      "quality.sh": [
        "#!/bin/bash",
        "if [ -f regression.txt ]; then",
        "  printf '%s\\n' '------- output -------' 'foo: command not found' '----- output end -----' 'other test ... FAILED (1ms)'",
        "  exit 1",
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    },
    async (dir) => {
      await git(dir, "checkout", "--quiet", "-b", "feature");
      await Deno.writeTextFile(`${dir}/regression.txt`, "new failure\n");
      await git(dir, "add", "regression.txt");
      await git(dir, "commit", "--quiet", "-m", "add regression");
      let gateRuns = 0;
      const v = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO, baseRef: "main" },
          {
            runGate: (params, deps) => {
              gateRuns++;
              return realGate(params, deps);
            },
          },
        ),
        "failed",
      );
      assertStringIncludes(v.output, "other test ... FAILED");
      assertEquals(gateRuns, 2, "head and base gates both ran");
    },
  );
});

Deno.test("a gate killed by its timeout is failed, whatever its output", async (t) => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    for (const exitCode of [124, 137, 143]) {
      await t.step(`exit ${exitCode} is failed`, async () => {
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
          "failed",
        );
        assertStringIncludes(v.output, `timed out (exit ${exitCode})`);
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

Deno.test("a failed gate that only names a disk fault in test names stays failed, with its output returned", async () => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    const output = [
      "classifyBuildFailure - names the ENOSPC export failure as builder storage ... ok (3ms)",
      "reports No space left on device as host disk ... FAILED (4ms)",
      "ERRORS",
      "reports No space left on device as host disk => ./tests/x_test.ts:12:6",
      "  12 | const text = 'No space left on device';",
      "FAILED | 10 passed | 1 failed",
      "",
    ].join("\n");
    const v = expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO },
        { runGate: stubGate({ action: "failed", qualityOutput: output }) },
      ),
      "failed",
    );
    assertStringIncludes(v.output, "names the ENOSPC export failure");
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

// --- Runner account protection (PR #4800 review) ---

Deno.test("requireSeparateAccount: with no separate account the repository's command never runs", async () => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    let spawned = 0;
    const createDeps = () => ({
      ...createDefaultDeps(),
      runCommand: () => {
        spawned++;
        return Promise.resolve({ exitCode: 0, output: "" });
      },
    });
    const refused = expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO, requireSeparateAccount: true },
        {
          createDeps,
          runGate: gateRunning(PASS),
          canDropPrivileges: () => Promise.resolve(false),
        },
      ),
      "unavailable",
    );
    assertStringIncludes(refused.reason, "separate account");
    assertEquals(spawned, 0);

    // Positive control: the same request on a host that can drop runs and passes.
    expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO, requireSeparateAccount: true },
        {
          createDeps,
          runGate: gateRunning(PASS),
          canDropPrivileges: () => Promise.resolve(true),
          reachableBySeparateAccount: () => Promise.resolve(true),
        },
      ),
      "passed",
    );
    assertEquals(spawned, 1);

    // A caller that does not ask for the protection is unchanged.
    expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO },
        {
          createDeps,
          runGate: gateRunning(PASS),
          canDropPrivileges: () => Promise.resolve(false),
        },
      ),
      "passed",
    );
  });
});

// --- A failure that reproduces on the base commit (PR #4800 review) ---

/** A repo with `main` and a `feature` branch one commit ahead, checked out. */
async function withFeatureBranch(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  await withRepo({ "README.md": "base\n" }, async (dir) => {
    await git(dir, "checkout", "--quiet", "-b", "feature");
    await Deno.writeTextFile(`${dir}/change.txt`, "change\n");
    await git(dir, "add", "-A");
    await git(dir, "commit", "--quiet", "-m", "change");
    await fn(dir);
  });
}

function gateByCheckout(
  headResult: QualityGateRunResult,
  baseResult: QualityGateRunResult,
  runs: string[],
) {
  return (
    _params: QualityGateParams,
    deps: QualityGateDeps,
  ): Promise<QualityGateRunResult> => {
    const where = deps.getCwd();
    runs.push(where);
    return Promise.resolve(
      where.includes("vibe-base-gate-") ? baseResult : headResult,
    );
  };
}

Deno.test("a gate failure that reproduces on the base commit is unavailable, not a content verdict", async () => {
  _resetBaseGateOutcomes();
  const red: QualityGateRunResult = {
    action: "failed",
    qualityOutput:
      "rustup could not choose a version of cargo-fmt\n2 tests failed\n",
  };
  await withFeatureBranch(async (dir) => {
    const runs: string[] = [];
    const v = expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO, baseRef: "main" },
        { runGate: gateByCheckout(red, red, runs) },
      ),
      "unavailable",
    );
    assertStringIncludes(v.reason, "reproduces on main@");
    assertEquals(runs.length, 2);

    // The base outcome is cached per base SHA: a second validation does not re-run it.
    expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO, baseRef: "main" },
        { runGate: gateByCheckout(red, red, runs) },
      ),
      "unavailable",
    );
    assertEquals(runs.length, 3);
  });
});

Deno.test("a gate failure the base commit does not share stays failed", async (t) => {
  const red = (output: string): QualityGateRunResult => ({
    action: "failed",
    qualityOutput: output,
  });
  await t.step("the base gate passes", async () => {
    _resetBaseGateOutcomes();
    await withFeatureBranch(async (dir) => {
      expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO, baseRef: "main" },
          { runGate: gateByCheckout(red("1 test failed\n"), PASS, []) },
        ),
        "failed",
      );
    });
  });
  await t.step("the head fails with a line the base lacks", async () => {
    _resetBaseGateOutcomes();
    await withFeatureBranch(async (dir) => {
      expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO, baseRef: "main" },
          {
            runGate: gateByCheckout(
              red("1 test failed\nnew regression in change.txt\n"),
              red("1 test failed\n"),
              [],
            ),
          },
        ),
        "failed",
      );
    });
  });
  await t.step("no base ref resolves", async () => {
    _resetBaseGateOutcomes();
    await withFeatureBranch(async (dir) => {
      const runs: string[] = [];
      expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO, baseRef: "origin/nowhere" },
          {
            runGate: gateByCheckout(
              red("1 test failed\n"),
              red("1 test failed\n"),
              runs,
            ),
          },
        ),
        "failed",
      );
      assertEquals(runs.length, 1);
    });
  });
});

Deno.test("a head whose PASSED count moved, failing the same way as the base, reproduces on the base", async (t) => {
  const red = (output: string): QualityGateRunResult => ({
    action: "failed",
    qualityOutput: output,
  });
  await t.step("only the passing count differs", async () => {
    _resetBaseGateOutcomes();
    await withFeatureBranch(async (dir) => {
      const v = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO, baseRef: "main" },
          {
            runGate: gateByCheckout(
              red(
                "hardcoded branch names: PASSED (13 files scanned)\n1 test failed\n",
              ),
              red(
                "hardcoded branch names: PASSED (12 files scanned)\n1 test failed\n",
              ),
              [],
            ),
          },
        ),
        "unavailable",
      );
      assertStringIncludes(v.reason, "reproduces on main@");
    });
  });
  await t.step(
    "the head also has a genuinely different failure line",
    async () => {
      _resetBaseGateOutcomes();
      await withFeatureBranch(async (dir) => {
        expectStatus(
          await validateRepositoryForPublication(
            { cwd: dir, repo: REPO, baseRef: "main" },
            {
              runGate: gateByCheckout(
                red(
                  "hardcoded branch names: PASSED (13 files scanned)\n1 test failed\nnew regression in change.txt\n",
                ),
                red(
                  "hardcoded branch names: PASSED (12 files scanned)\n1 test failed\n",
                ),
                [],
              ),
            },
          ),
          "failed",
        );
      });
    },
  );
});

// --- A refused gate has no side effects (PR #4800 review) ---

Deno.test("requireSeparateAccount: the real gate is never entered on a host that cannot drop", async () => {
  await withRepo({ "quality.sh": "#!/bin/bash\nexit 0\n" }, async (dir) => {
    const calls: string[] = [];
    const createDeps = (): QualityGateDeps => ({
      ...createDefaultDeps(),
      cleanupPorts: () => {
        calls.push("cleanupPorts");
        return Promise.resolve();
      },
      cleanupSubprocesses: () => {
        calls.push("cleanupSubprocesses");
        return Promise.resolve();
      },
      runCommand: () => {
        calls.push("runCommand");
        return Promise.resolve({ exitCode: 0, output: "" });
      },
    });
    const refused = expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO, requireSeparateAccount: true },
        {
          createDeps,
          runGate: runQualityGateCheck,
          canDropPrivileges: () => Promise.resolve(false),
        },
      ),
      "unavailable",
    );
    assertStringIncludes(refused.reason, "separate account");
    assertEquals(calls, []);

    // Positive control: where the host can drop, the command runs, and the
    // machine-wide sweeps still do not (they would kill the operator's own
    // processes and another repair's gate).
    expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO, requireSeparateAccount: true },
        {
          createDeps,
          runGate: runQualityGateCheck,
          canDropPrivileges: () => Promise.resolve(true),
          reachableBySeparateAccount: () => Promise.resolve(true),
        },
      ),
      "passed",
    );
    assertEquals(calls, ["runCommand"]);

    // A caller in the isolated worker container keeps its sweeps.
    calls.length = 0;
    expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO },
        { createDeps, runGate: runQualityGateCheck },
      ),
      "passed",
    );
    assertEquals(calls, ["cleanupPorts", "runCommand", "cleanupSubprocesses"]);
  });
});

Deno.test("requireSeparateAccount: a repository with no gate is not refused", async () => {
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    const v = expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO, requireSeparateAccount: true },
        {
          runGate: runQualityGateCheck,
          canDropPrivileges: () => Promise.resolve(false),
        },
      ),
      "passed",
    );
    assertEquals(v.gate, "absent");
  });
});

Deno.test("requireSeparateAccount: the default spawn refuses the runner account by the argv it would run", async () => {
  const deps = createDefaultDeps({}, undefined, true);
  if (await canRunAsUntrustedUser()) {
    const ran = await deps.runCommand(["true"], { stdin: "null" });
    assertEquals(ran.exitCode, 0);
  } else {
    let thrown: unknown;
    try {
      await deps.runCommand(["true"], { stdin: "null" });
    } catch (error) {
      thrown = error;
    }
    assertInstanceOf(thrown, SeparateAccountRequiredError);
  }
});

Deno.test("probePublicationCapability: each fixed host property is named without running anything", async (t) => {
  const none = () => Promise.resolve(false);
  const yes = () => Promise.resolve(true);
  await withRepo({ "quality.sh": "#!/bin/bash\nexit 0\n" }, async (dir) => {
    const base = { cwd: dir, repo: REPO };
    await t.step("a host that cannot drop is named", async () => {
      const reason = await probePublicationCapability(
        { ...base, requireSeparateAccount: true },
        { canDropPrivileges: none },
      );
      assertStringIncludes(reason ?? "", "separate account");
    });
    await t.step(
      "a host that can drop passes, as does a caller that does not ask",
      async () => {
        assertEquals(
          await probePublicationCapability(
            { ...base, requireSeparateAccount: true },
            { canDropPrivileges: yes, reachableBySeparateAccount: yes },
          ),
          undefined,
        );
        assertEquals(
          await probePublicationCapability(base, { canDropPrivileges: none }),
          undefined,
        );
      },
    );
    const docker: Record<string, RepoConfig> = {
      [REPO]: { dockerImage: "node:22" } as RepoConfig,
    };
    await t.step(
      "a docker_image repository on a host without Docker is named",
      async () => {
        const reason = await probePublicationCapability(
          { ...base, repoConfigs: docker },
          { dockerAvailable: none },
        );
        assertStringIncludes(reason ?? "", "Docker");
        assertEquals(
          await probePublicationCapability(
            { ...base, repoConfigs: docker },
            { dockerAvailable: yes },
          ),
          undefined,
        );
      },
    );
    await t.step("an opted-out repository is never refused", async () => {
      assertEquals(
        await probePublicationCapability(
          {
            ...base,
            requireSeparateAccount: true,
            repoConfigs: {
              [REPO]: { skipQualityCheck: true } as RepoConfig,
            },
          },
          { canDropPrivileges: none },
        ),
        undefined,
      );
    });
  });
  await withRepo({ "README.md": "hello\n" }, async (dir) => {
    assertEquals(
      await probePublicationCapability(
        { cwd: dir, repo: REPO, requireSeparateAccount: true },
        { canDropPrivileges: none },
      ),
      undefined,
    );
  });
});

// --- A separate account that cannot enter the clone (PR #4800 review) ---

Deno.test("probePublicationCapability: a separate account that cannot enter the clone is named", async () => {
  const yes = () => Promise.resolve(true);
  const unreachable = () => Promise.resolve(false);
  await withRepo({ "quality.sh": "#!/bin/bash\nexit 0\n" }, async (dir) => {
    const base = { cwd: dir, repo: REPO, requireSeparateAccount: true };
    const reason = await probePublicationCapability(base, {
      canDropPrivileges: yes,
      reachableBySeparateAccount: unreachable,
    });
    assertStringIncludes(reason ?? "", "cannot enter the checkout");
    assertEquals(
      await probePublicationCapability(base, {
        canDropPrivileges: yes,
        reachableBySeparateAccount: yes,
      }),
      undefined,
    );
  });
});

Deno.test("requireSeparateAccount: the reachability probe is asked about the checkout and its gate script", async () => {
  await withRepo({ "quality.sh": "#!/bin/bash\nexit 0\n" }, async (dir) => {
    const asked: Array<[string, string | undefined]> = [];
    const reachable = (cwd: string, script: string | undefined) => {
      asked.push([cwd, script]);
      return Promise.resolve(true);
    };
    const request = { cwd: dir, repo: REPO, requireSeparateAccount: true };
    await probePublicationCapability(request, {
      canDropPrivileges: () => Promise.resolve(true),
      reachableBySeparateAccount: reachable,
    });
    expectStatus(
      await validateRepositoryForPublication(request, {
        runGate: stubGate(PASS),
        canDropPrivileges: () => Promise.resolve(true),
        reachableBySeparateAccount: reachable,
      }),
      "passed",
    );
    assertEquals(asked, [
      [dir, `${dir}/quality.sh`],
      [dir, `${dir}/quality.sh`],
    ]);
  });
});

Deno.test("requireSeparateAccount: a clone the separate account cannot enter is unavailable, and the gate never runs", async () => {
  await withRepo({ "quality.sh": "#!/bin/bash\nexit 0\n" }, async (dir) => {
    const calls: GateCall[] = [];
    const refused = expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO, requireSeparateAccount: true },
        {
          runGate: stubGate(PASS, calls),
          canDropPrivileges: () => Promise.resolve(true),
          reachableBySeparateAccount: () => Promise.resolve(false),
        },
      ),
      "unavailable",
    );
    assertStringIncludes(refused.reason, "cannot enter the checkout");
    assertEquals(refused.head, await git(dir, "rev-parse", "HEAD"));
    assertEquals(calls.length, 0);

    // Positive control: the same clone, reachable by the separate account, runs the gate.
    expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO, requireSeparateAccount: true },
        {
          runGate: stubGate(PASS, calls),
          canDropPrivileges: () => Promise.resolve(true),
          reachableBySeparateAccount: () => Promise.resolve(true),
        },
      ),
      "passed",
    );
    assertEquals(calls.length, 1);
  });
});

// --- Real gate output on the base commit (PR #4800 review) ---

/** A quality.sh that fails on a host fault and prints the checkout's own path. */
const HOST_FAULT_QUALITY_SH = `#!/bin/bash
echo "running $(wc -l < tests.txt | tr -d ' ') tests from ./x_test.ts"
while read -r name; do echo "$name ... ok (2ms)"; done < tests.txt
echo "cargo-fmt ... FAILED (3ms)"
echo "error: rustup could not choose a version of cargo-fmt"
echo "    at file://$PWD/lib/x.ts:10:5"
echo "FAILED | $(wc -l < tests.txt | tr -d ' ') passed | 1 failed (9ms)"
exit 1
`;

Deno.test("failureEvidenceLines: checkout paths and passing or count lines do not separate two runs", () => {
  const head = failureEvidenceLines(
    "a ... ok (1ms)\nb ... ok (2ms)\nboom ... FAILED (3ms)\n" +
      "    at file:///work/head/lib/x.ts:1:2\nFAILED | 2 passed | 1 failed (9ms)\n",
    ["/work/head"],
  );
  const base = failureEvidenceLines(
    "a ... ok (4ms)\nboom ... FAILED (5ms)\n" +
      "    at file:///tmp/base/tree/lib/x.ts:1:2\nFAILED | 1 passed | 1 failed (7ms)\n",
    ["/tmp/base/tree"],
  );
  assertEquals(head, base);
  assertEquals(head.length, 2);
});

Deno.test("failureEvidenceLines drops a `<label>: PASSED` line but keeps FAILED and real failure lines", () => {
  assertEquals(
    failureEvidenceLines(
      "hardcoded branch names: PASSED (13 files scanned)\n" +
        "hardcoded branch names: FAILED (1 file)\n" +
        "error: boom in lib/x.ts\n",
      [],
    ),
    ["hardcoded branch names: FAILED (1 file)", "error: boom in lib/x.ts"],
  );
});

Deno.test("failureEvidenceLines keeps a very long line with no colon, without hanging", () => {
  const line = "a".repeat(100000);
  assertEquals(failureEvidenceLines(line, []), [line]);
});

Deno.test("a failure that is the same on the base reproduces despite checkout paths and an added passing test", async () => {
  _resetBaseGateOutcomes();
  await withRepo(
    {
      "quality.sh": HOST_FAULT_QUALITY_SH,
      "tests.txt": "first\n",
    },
    async (dir) => {
      await git(dir, "checkout", "--quiet", "-b", "feature");
      await Deno.writeTextFile(`${dir}/tests.txt`, "first\nsecond\n");
      await git(dir, "commit", "--quiet", "-am", "add a passing test");
      const v = expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO, baseRef: "main" },
          { runGate: realGate },
        ),
        "unavailable",
      );
      assertStringIncludes(v.reason, "reproduces on main@");
    },
  );
});

Deno.test("a head that adds a failure line the base lacks stays failed under the real gate", async () => {
  _resetBaseGateOutcomes();
  await withRepo(
    {
      "quality.sh": HOST_FAULT_QUALITY_SH,
      "tests.txt": "first\n",
    },
    async (dir) => {
      await git(dir, "checkout", "--quiet", "-b", "feature");
      await Deno.writeTextFile(
        `${dir}/quality.sh`,
        HOST_FAULT_QUALITY_SH.replace(
          "exit 1",
          'echo "error: new regression in lib/x.ts"\nexit 1',
        ),
      );
      await git(dir, "commit", "--quiet", "-am", "regress");
      expectStatus(
        await validateRepositoryForPublication(
          { cwd: dir, repo: REPO, baseRef: "main" },
          { runGate: realGate },
        ),
        "failed",
      );
    },
  );
});

Deno.test("the base-commit tree is reachable by another account", async () => {
  if (Deno.env.get("VIBE_PRIVATE_TMP_TEST") !== "1") {
    const privateTmp = await Deno.makeTempDir();
    try {
      const result = await new Deno.Command(Deno.execPath(), {
        args: [
          "task",
          "test",
          "--filter",
          "the base-commit tree is reachable by another account",
          "tests/publication_validation_test.ts",
        ],
        env: { TMPDIR: privateTmp, VIBE_PRIVATE_TMP_TEST: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(
        result.success,
        true,
        decoder.decode(result.stdout) + decoder.decode(result.stderr),
      );
      assertStringIncludes(decoder.decode(result.stdout), "1 passed");
    } finally {
      await Deno.remove(privateTmp, { recursive: true });
    }
    return;
  }
  _resetBaseGateOutcomes();
  await withFeatureBranch(async (dir) => {
    const red: QualityGateRunResult = {
      action: "failed",
      qualityOutput: "1 test failed\n",
    };
    const modes: number[] = [];
    const gate = (
      _params: QualityGateParams,
      deps: QualityGateDeps,
    ): Promise<QualityGateRunResult> => {
      const where = deps.getCwd();
      if (where.includes("vibe-base-gate-")) {
        const parent = where.slice(0, where.lastIndexOf("/"));
        let path = parent;
        while (path !== "/") {
          modes.push(Deno.statSync(path).mode! & 0o001);
          path = path.slice(0, path.lastIndexOf("/")) || "/";
        }
      }
      return Promise.resolve(red);
    };
    expectStatus(
      await validateRepositoryForPublication(
        { cwd: dir, repo: REPO, baseRef: "main" },
        { runGate: gate },
      ),
      "unavailable",
    );
    assertEquals(modes.length > 0, true);
    assertEquals(modes.every((mode) => mode === 1), true);
  });
});
