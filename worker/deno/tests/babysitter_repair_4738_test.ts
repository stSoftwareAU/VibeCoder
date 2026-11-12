/**
 * Tests for the babysitter-repair command (Issue #4768).
 *
 * Real temp directories and files; the provider choice and the agent runner
 * are injected fakes, so no real agent runs and nothing sleeps.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  babysitterRepairCommand,
  type BabysitterRepairDeps,
  exportBabysitterSubscriptionCredentials,
  productionBabysitterRepairDeps,
  runBabysitterRepair,
} from "../commands/babysitter_repair.ts";
import { parseArgs } from "../mod.ts";
import { buildBabysitterRunArgs } from "../lib/fleet_babysitter_container.ts";
import { isBabysitterReady } from "../lib/babysitter_ready.ts";
import {
  BABYSITTER_GATE_BLOCKED_MARKER,
  type BabysitterTreeGateOutcome,
  isGateInfrastructureResponse,
  runBabysitterTreeGate,
} from "../lib/babysitter_tree_gate.ts";
import {
  agentClone,
  editFoo,
  FOO_FAILURE,
} from "./support/babysitter_tree_fixture.ts";
import { chooseBabysitterProvider } from "../lib/babysitter_provider_choice.ts";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import {
  BABYSITTER_QUOTA_PARK_EXIT_CODE,
  BABYSITTER_TASK_FAILURE_EXIT_CODE,
} from "../lib/fleet_babysitter_container.ts";
import type {
  BabysitterProviderChoice,
  BabysitterProviderChoiceDeps,
} from "../lib/babysitter_provider_choice.ts";
import type {
  ClaudeExecutionResult,
  RunClaudeOptions,
} from "../lib/claude_runner.ts";
import type { Result, WorkerConfig } from "../types.ts";

const CONFIG = {
  workDir: "/work",
  enabledAgentProviders: ["claude", "codex", "deepseek"],
} as unknown as WorkerConfig;

const CLAUDE_CHOICE: BabysitterProviderChoice = {
  providerId: "claude",
  overflow: false,
  env: {},
};

interface Paths {
  readonly root: string;
  readonly dir: string;
  readonly prompt: string;
  readonly response: string;
}

interface Harness {
  readonly deps: BabysitterRepairDeps;
  readonly runs: RunClaudeOptions[];
  readonly chooseCalls: BabysitterProviderChoiceDeps[];
  readonly logs: string[];
  /** The order the credential export and the provider choice ran in. */
  readonly order: string[];
  readonly exportCalls: { enabledProviderIds: readonly string[] }[];
  /** The directory and base branch each pre-push gate call received (#4930). */
  readonly treeCalls: { dir: string; baseBranch: string | undefined }[];
}

/** Run `body` in a fresh temp workspace with a clone dir, removed afterwards. */
async function inWorkspace(
  body: (paths: Paths) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "babysitter-repair-4768-" });
  try {
    const dir = `${root}/clone`;
    await Deno.mkdir(dir);
    await body({
      root,
      dir,
      prompt: `${root}/prompt.md`,
      response: `${root}/response.md`,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** The CLI arguments for `paths`; an override of `undefined` drops a flag. */
function argsFor(
  paths: Paths,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    dir: paths.dir,
    "prompt-file": paths.prompt,
    "response-file": paths.response,
    ...overrides,
  };
}

/** A successful runner result whose final message is `output`. */
function finished(
  overrides: Partial<ClaudeExecutionResult> = {},
): Result<ClaudeExecutionResult> {
  return {
    ok: true,
    value: {
      exitCode: 0,
      output: "FINAL MESSAGE",
      stderr: "",
      timedOut: false,
      ...overrides,
    },
  };
}

/** Fake seams: real file IO, a fake provider choice and a fake runner. */
function harness(
  choice: BabysitterProviderChoice | Error = CLAUDE_CHOICE,
  run: Result<ClaudeExecutionResult> = finished(),
  tree: BabysitterTreeGateOutcome = { kind: "clean" },
): Harness {
  const runs: RunClaudeOptions[] = [];
  const chooseCalls: BabysitterProviderChoiceDeps[] = [];
  const logs: string[] = [];
  const order: string[] = [];
  const exportCalls: { enabledProviderIds: readonly string[] }[] = [];
  const treeCalls: { dir: string; baseBranch: string | undefined }[] = [];
  const deps: BabysitterRepairDeps = {
    readTextFile: (path) => Deno.readTextFile(path),
    writeTextFile: (path, text) => Deno.writeTextFile(path, text),
    removeFile: (path) => Deno.remove(path),
    exportSubscriptionCredentials: async (options) => {
      order.push("export");
      exportCalls.push({ enabledProviderIds: options.enabledProviderIds });
      return ["CLAUDE_CODE_OAUTH_TOKEN"];
    },
    chooseProvider: async (choiceDeps) => {
      order.push("choose");
      chooseCalls.push(choiceDeps);
      if (choice instanceof Error) throw choice;
      return choice;
    },
    runClaude: async (options) => {
      runs.push(options);
      return run;
    },
    treeGate: async (dir, baseBranch) => {
      treeCalls.push({ dir, baseBranch });
      return tree;
    },
    log: (message) => logs.push(message),
  };
  return { deps, runs, chooseCalls, logs, order, exportCalls, treeCalls };
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Write a prompt the repair can read. */
async function writePrompt(
  paths: Paths,
  text = "REPAIR PROMPT",
): Promise<void> {
  await Deno.writeTextFile(paths.prompt, text);
}

/** Leave an old response behind, as a previous run would have. */
async function writeStale(paths: Paths): Promise<void> {
  await Deno.writeTextFile(paths.response, "STALE RESPONSE");
}

Deno.test("success writes the runner's final message and returns success", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness();

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, true);
    assertEquals(result.exitCode, 0);
    assertEquals(await Deno.readTextFile(paths.response), "FINAL MESSAGE");
    assertEquals(h.runs.length, 1);
    assertEquals(h.runs[0]!.cwd, paths.dir);
    assertEquals(h.runs[0]!.timeoutSeconds, 5400);
    assertEquals(h.runs[0]!.agentProvider, "claude");
    assertEquals(h.runs[0]!.prompt, "REPAIR PROMPT");
    assertEquals("parentEnv" in h.runs[0]!, false);
    assertEquals(h.chooseCalls[0]!.workDir, "/work");
    assertEquals(
      h.chooseCalls[0]!.enabledProviderIds,
      CONFIG.enabledAgentProviders,
    );
    assertStringIncludes(h.logs.join("\n"), "provider=claude overflow=false");
  });
});

Deno.test("DeepSeek overflow forwards the choice env as parentEnv", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness({
      providerId: "deepseek",
      overflow: true,
      env: { MARK: "deepseek-env" },
    });

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, true);
    assertEquals(h.runs[0]!.agentProvider, "deepseek");
    assertEquals(h.runs[0]!.parentEnv, { MARK: "deepseek-env" });
    assertStringIncludes(h.logs.join("\n"), "overflow=true");
  });
});

Deno.test("subscription choice sends no parentEnv even when the choice carries an env", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness({
      providerId: "codex",
      overflow: false,
      env: { MARK: "subscription-env" },
    });

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, true);
    assertEquals(h.runs[0]!.agentProvider, "codex");
    assertEquals("parentEnv" in h.runs[0]!, false);
  });
});

Deno.test("provider-choice throw fails with its cause and removes a stale response", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    await writeStale(paths);
    const h = harness(
      new Error(
        "no subscription has budget and no DeepSeek credential is configured",
      ),
    );

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, false);
    assertEquals(result.exitCode, 1);
    assertStringIncludes(result.message, "no subscription has budget");
    assertEquals(h.logs.at(-1), result.message);
    assertEquals(h.runs.length, 0);
    assertEquals(await exists(paths.response), false);
  });
});

Deno.test("classified agent failure reaches stderr and leaves no response", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    await writeStale(paths);
    const h = harness(
      CLAUDE_CHOICE,
      finished({
        exitCode: 1,
        stderr: "",
        agentFailure: {
          category: "authentication",
          message: "login failed GITHUB_TOKEN=fixture-secret",
          evidence: "structured",
          terminal: true,
          errors: [],
        },
      }),
    );
    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "authentication");
    assertStringIncludes(result.message, "login failed");
    assertEquals(result.exitCode, 1);
    assert(!result.message.includes("fixture-secret"));
    assertEquals(h.logs.at(-1), result.message);
    assertEquals(await exists(paths.response), false);
  });
});

Deno.test("a task-failure category carries the reserved retry exit status", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness(
      CLAUDE_CHOICE,
      finished({
        exitCode: 1,
        stderr: "",
        agentFailure: {
          category: "task-failure",
          message: "tests failed",
          evidence: "structured",
          terminal: true,
          errors: [],
        },
      }),
    );
    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);
    assertEquals(result.success, false);
    assertEquals(result.exitCode, BABYSITTER_TASK_FAILURE_EXIT_CODE);
    assertStringIncludes(result.message, "task-failure: tests failed");
    assertEquals(await exists(paths.response), false);
  });
});

Deno.test("runner error result fails with its cause and removes a stale response", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    await writeStale(paths);
    const h = harness(CLAUDE_CHOICE, {
      ok: false,
      error: new Error("spawn claude ENOENT"),
    });

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "spawn claude ENOENT");
    assertEquals(await exists(paths.response), false);
  });
});

Deno.test("a runner that throws after writing the response fails with its cause and removes the file", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    await writeStale(paths);
    const h = harness();
    h.deps.runClaude = async () => {
      await Deno.writeTextFile(paths.response, "WRITTEN BY AGENT");
      throw new Error("runner exploded");
    };

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "runner exploded");
    assertEquals(await exists(paths.response), false);
  });
});

Deno.test("timed-out run fails with the timeout reason and removes a stale response", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    await writeStale(paths);
    const h = harness(
      CLAUDE_CHOICE,
      finished({
        exitCode: 124,
        timedOut: true,
        timeoutReason: "hard-timeout",
      }),
    );

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "timed out");
    assertStringIncludes(result.message, "hard-timeout");
    assertEquals(await exists(paths.response), false);
  });
});

Deno.test("non-zero exit fails with the code and a redacted stderr tail", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    await writeStale(paths);
    const h = harness(
      CLAUDE_CHOICE,
      finished({
        exitCode: 2,
        output: "partial text that must not be written",
        stderr: "auth failed: GITHUB_TOKEN=fixture-not-a-secret",
      }),
    );

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "exited 2");
    assertStringIncludes(result.message, "auth failed");
    assertEquals(result.message.includes("fixture-not-a-secret"), false);
    assertEquals(await exists(paths.response), false);
  });
});

Deno.test("empty final message fails and removes a stale response", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    await writeStale(paths);
    const h = harness(CLAUDE_CHOICE, finished({ output: "   \n" }));

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "empty final message");
    assertEquals(await exists(paths.response), false);
  });
});

Deno.test("missing prompt file fails before the runner and removes a stale response", async () => {
  await inWorkspace(async (paths) => {
    await writeStale(paths);
    const h = harness();

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "cannot read prompt file");
    assertStringIncludes(result.message, paths.prompt);
    assertEquals(h.runs.length, 0);
    assertEquals(await exists(paths.response), false);
  });
});

Deno.test("whitespace-only prompt file fails before the runner", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths, " \n\t ");
    const h = harness();

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "is empty");
    assertEquals(h.runs.length, 0);
    assertEquals(await exists(paths.response), false);
  });
});

Deno.test("missing, blank or bare required flags are refused naming the flag", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["--dir", { dir: undefined }],
    ["--dir", { dir: "   " }],
    ["--dir", { dir: true }],
    ["--prompt-file", { "prompt-file": "" }],
    ["--prompt-file", { "prompt-file": true }],
    ["--response-file", { "response-file": "true" }],
  ];
  for (const [flag, override] of cases) {
    await inWorkspace(async (paths) => {
      await writePrompt(paths);
      const h = harness();

      const result = await runBabysitterRepair(
        argsFor(paths, override),
        CONFIG,
        h.deps,
      );

      assertEquals(
        result.success,
        false,
        `${flag} ${JSON.stringify(override)}`,
      );
      assertStringIncludes(result.message, flag);
      assertEquals(h.runs.length, 0);
      assertEquals(h.chooseCalls.length, 0);
    });
  }
});

Deno.test("babysitter-repair command object is wired and refuses a bad flag", async () => {
  assertEquals(babysitterRepairCommand.name, "babysitter-repair");
  const result = await babysitterRepairCommand.execute(
    {
      dir: "true",
      "prompt-file": "/nonexistent",
      "response-file": "/nonexistent",
    },
    CONFIG,
  );
  assertEquals(result.success, false);
  assert(result.message.includes("--dir"));
});

Deno.test("a stale response that cannot be removed fails with the cause before the runner", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    await writeStale(paths);
    const h = harness();
    h.deps.removeFile = async () => {
      throw new Deno.errors.PermissionDenied("stale-remove-denied fixture");
    };

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "cannot remove stale response file");
    assertStringIncludes(result.message, "stale-remove-denied fixture");
    assertEquals(h.runs.length, 0);
  });
});

Deno.test("a failed final write fails with its cause and clears the partial response", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness();
    const removed: string[] = [];
    const removeFile = h.deps.removeFile;
    h.deps.removeFile = async (path) => {
      removed.push(path);
      await removeFile(path);
    };
    h.deps.writeTextFile = async (path) => {
      await Deno.writeTextFile(path, "PARTIAL");
      throw new Error("disk-full fixture");
    };

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "disk-full fixture");
    assertEquals(removed[removed.length - 1], paths.response);
    assertEquals(await exists(paths.response), false);
  });
});

Deno.test("a failed final write names both causes when the partial response also cannot be removed", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness();
    let written = false;
    const removeFile = h.deps.removeFile;
    h.deps.removeFile = async (path) => {
      if (written) {
        throw new Deno.errors.PermissionDenied("remove-denied fixture");
      }
      await removeFile(path);
    };
    h.deps.writeTextFile = async (path) => {
      written = true;
      await Deno.writeTextFile(path, "PARTIAL");
      throw new Error("disk-full fixture");
    };

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "disk-full fixture");
    assertStringIncludes(result.message, "also could not remove");
    assertStringIncludes(result.message, "remove-denied fixture");
    assertEquals(await exists(paths.response), true);
  });
});

/** Runner outcomes that fail after the agent has written the response itself. */
Deno.test("READY with a blocked pre-push gate withholds READY and still succeeds (#4930)", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness(
      CLAUDE_CHOICE,
      finished({ output: "done\nBABYSITTER_READY" }),
      { kind: "blocked", message: "deno test failed: a_test.ts" },
    );

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, true);
    assertEquals(result.exitCode, 0);
    const written = await Deno.readTextFile(paths.response);
    assert(
      written.startsWith(
        `${BABYSITTER_GATE_BLOCKED_MARKER} pre-push checks failed: deno test failed: a_test.ts`,
      ),
    );
    assertEquals(isBabysitterReady(written), false);
    assertStringIncludes(written, "done");
    assertEquals(h.treeCalls.length, 1);
    assertEquals(h.treeCalls[0]!.dir, paths.dir);
  });
});

Deno.test("READY with an infrastructure gate failure withholds READY and still succeeds (#4930)", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness(
      CLAUDE_CHOICE,
      finished({ output: "done\nBABYSITTER_READY" }),
      { kind: "infrastructure", message: "git ls-files failed" },
    );

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, true);
    assertEquals(result.exitCode, 0);
    const written = await Deno.readTextFile(paths.response);
    assert(
      written.startsWith(
        `${BABYSITTER_GATE_BLOCKED_MARKER} pre-push checks could not run: git ls-files failed`,
      ),
    );
    assertEquals(isBabysitterReady(written), false);
  });
});

Deno.test("READY with a passed pre-push gate writes the output unchanged (#4930)", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness(
      CLAUDE_CHOICE,
      finished({ output: "done\nBABYSITTER_READY" }),
      { kind: "passed", checksRun: ["deno test a.ts"] },
    );

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, true);
    assertEquals(
      await Deno.readTextFile(paths.response),
      "done\nBABYSITTER_READY",
    );
    assertStringIncludes(
      h.logs.join("\n"),
      "pre-push checks passed: deno test a.ts",
    );
  });
});

Deno.test("READY with a clean tree writes the output unchanged (#4930)", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness(
      CLAUDE_CHOICE,
      finished({ output: "done\nBABYSITTER_READY" }),
      { kind: "clean" },
    );

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, true);
    assertEquals(
      await Deno.readTextFile(paths.response),
      "done\nBABYSITTER_READY",
    );
    assertEquals(h.treeCalls.length, 1);
  });
});

Deno.test("a response that is not ready never reaches the pre-push gate (#4930)", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness(CLAUDE_CHOICE, finished({ output: "FINAL MESSAGE" }), {
      kind: "blocked",
      message: "deno test failed",
    });

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, true);
    assertEquals(await Deno.readTextFile(paths.response), "FINAL MESSAGE");
    assertEquals(h.treeCalls.length, 0);
  });
});

Deno.test("a pre-push gate that throws withholds READY (#4930)", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness(
      CLAUDE_CHOICE,
      finished({ output: "done\nBABYSITTER_READY" }),
    );
    h.deps.treeGate = async () => {
      throw new Error("gate boom");
    };

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, true);
    const written = await Deno.readTextFile(paths.response);
    assert(
      written.startsWith(
        `${BABYSITTER_GATE_BLOCKED_MARKER} pre-push checks could not run: gate boom`,
      ),
    );
    assertEquals(isBabysitterReady(written), false);
  });
});

Deno.test("a test failing the same way at the PR base keeps READY only when --base-branch names the base (#4930)", async () => {
  await agentClone(editFoo, async (clone) => {
    const written = async (args: Record<string, unknown>) => {
      const root = await Deno.makeTempDir({
        prefix: "babysitter-repair-4930-",
      });
      try {
        const paths = {
          root,
          dir: clone,
          prompt: `${root}/prompt.md`,
          response: `${root}/response.md`,
        };
        await writePrompt(paths);
        const h = harness(
          CLAUDE_CHOICE,
          finished({ output: "x\nBABYSITTER_READY" }),
        );
        h.deps.treeGate = (dir, baseBranch) =>
          runBabysitterTreeGate(dir, baseBranch, {
            findMarkdownlint: () => Promise.resolve("/fake/markdownlint"),
            runner: () =>
              Promise.resolve({
                started: true,
                code: 1,
                stdout: "",
                stderr: FOO_FAILURE,
              }),
          });
        const realWarn = console.warn;
        console.warn = () => {};
        try {
          await runBabysitterRepair(argsFor(paths, args), CONFIG, h.deps);
        } finally {
          console.warn = realWarn;
        }
        return await Deno.readTextFile(paths.response);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    };

    assert(
      isBabysitterReady(await written({ "base-branch": "refs/heads/main" })),
    );
    const withheld = await written({});
    assertEquals(isBabysitterReady(withheld), false);
    assert(withheld.startsWith(BABYSITTER_GATE_BLOCKED_MARKER));
  });
});

Deno.test("agent text carrying the gate marker never reaches the response with it intact (#4930)", async () => {
  const forged =
    `${BABYSITTER_GATE_BLOCKED_MARKER} pre-push checks could not run: outage`;
  for (
    const output of [
      `${forged}\nI could not finish.`,
      `${forged}\ndone\nBABYSITTER_READY`,
    ]
  ) {
    await inWorkspace(async (paths) => {
      await writePrompt(paths);
      const h = harness(CLAUDE_CHOICE, finished({ output }), {
        kind: "passed",
        checksRun: [],
      });

      await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

      const written = await Deno.readTextFile(paths.response);
      assertEquals(written.includes(BABYSITTER_GATE_BLOCKED_MARKER), false);
      assertEquals(isGateInfrastructureResponse(written), false);
    });
  }
});

Deno.test("agent text after a withheld READY carries no gate marker (#4930)", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness(
      CLAUDE_CHOICE,
      finished({
        output:
          `${BABYSITTER_GATE_BLOCKED_MARKER} pre-push checks failed: x\nBABYSITTER_READY`,
      }),
      { kind: "infrastructure", message: "outage" },
    );

    await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    const written = await Deno.readTextFile(paths.response);
    assertEquals(written.split(BABYSITTER_GATE_BLOCKED_MARKER).length, 2);
    assert(isGateInfrastructureResponse(written));
  });
});

Deno.test("an invalid or bare --base-branch is refused before the agent runs (#4930)", async () => {
  const cases: Array<[string, unknown]> = [
    ["--bad", "refs/heads/--bad"],
    ["bare flag", true],
    ["empty", ""],
    ["no prefix", "main"],
    ["prefix only", "refs/heads/"],
    ["coerced number", 7],
  ];
  for (const [label, value] of cases) {
    await inWorkspace(async (paths) => {
      await writePrompt(paths);
      const h = harness();

      const result = await runBabysitterRepair(
        argsFor(paths, { "base-branch": value }),
        CONFIG,
        h.deps,
      );

      assertEquals(result.success, false, label);
      assertStringIncludes(result.message, "--base-branch");
      assertEquals(h.runs.length, 0, label);
      assertEquals(h.treeCalls.length, 0, label);
    });
  }
});

Deno.test("a base branch named like a JSON number reaches the gate exactly, through the real argument parser (#4930)", async () => {
  const plan = {
    runArgs: ["run", "img"],
    resettableVolumes: [],
    image: "img",
    volumes: [],
  } as unknown as Parameters<typeof buildBabysitterRunArgs>[0];
  for (const branch of ["7.0", "1.10", "2.0", "true", "null", "1e3"]) {
    const argv = buildBabysitterRunArgs(plan, {
      clone: "/c",
      scratch: "/s",
      baseBranch: branch,
    });
    const tail = argv.slice(argv.indexOf("--base-branch") - 1);
    const parsed = parseArgs(tail);
    await inWorkspace(async (paths) => {
      await writePrompt(paths);
      const h = harness(
        CLAUDE_CHOICE,
        finished({ output: "done\nBABYSITTER_READY" }),
      );
      const result = await runBabysitterRepair(
        { ...argsFor(paths), ...parsed.args },
        CONFIG,
        h.deps,
      );
      assertEquals(result.success, true, branch);
      assertEquals(h.treeCalls.length, 1, branch);
      assertEquals(h.treeCalls[0]!.baseBranch, branch);
    });
  }
});

const AGENT_FAILURES: Array<[string, Result<ClaudeExecutionResult>]> = [
  [
    "timed-out run",
    finished({
      exitCode: 124,
      timedOut: true,
      timeoutReason: "hard-timeout",
    }),
  ],
  ["non-zero exit", finished({ exitCode: 2, stderr: "agent crashed" })],
  ["empty final message", finished({ output: "  \n" })],
];

for (const [label, run] of AGENT_FAILURES) {
  Deno.test(`${label} removes a response file the agent wrote itself`, async () => {
    await inWorkspace(async (paths) => {
      await writePrompt(paths);
      const h = harness(CLAUDE_CHOICE, run);
      h.deps.runClaude = async (options) => {
        h.runs.push(options);
        await Deno.writeTextFile(paths.response, "WRITTEN BY AGENT");
        return run;
      };

      const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

      assertEquals(result.success, false);
      assertEquals(h.runs.length, 1);
      assertEquals(await exists(paths.response), false);
    });
  });
}

const MISSING_WITH_STALE: Array<[string, Record<string, unknown>]> = [
  ["--dir", { dir: undefined }],
  ["--prompt-file", { "prompt-file": undefined }],
];

for (const [flag, override] of MISSING_WITH_STALE) {
  Deno.test(`missing ${flag} names the flag and removes a stale response`, async () => {
    await inWorkspace(async (paths) => {
      await writePrompt(paths);
      await writeStale(paths);
      const h = harness();

      const result = await runBabysitterRepair(
        argsFor(paths, override),
        CONFIG,
        h.deps,
      );

      assertEquals(result.success, false);
      assertStringIncludes(result.message, flag);
      assertEquals(h.runs.length, 0);
      assertEquals(await exists(paths.response), false);
    });
  });
}

Deno.test("missing --response-file fails naming the flag before anything runs", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness();

    const result = await runBabysitterRepair(
      argsFor(paths, { "response-file": undefined }),
      CONFIG,
      h.deps,
    );

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "--response-file");
    assertEquals(h.runs.length, 0);
    assertEquals(h.chooseCalls.length, 0);
  });
});

Deno.test("non-zero exit quotes both ends of long stderr and keeps the secret out", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const filler = "filler text ".repeat(200);
    const h = harness(
      CLAUDE_CHOICE,
      finished({
        exitCode: 3,
        output: "partial text that must not be written",
        stderr:
          `CAUSE-HEAD ${filler}GITHUB_TOKEN=fixture-middle-secret ${filler}CAUSE-TAIL`,
      }),
    );

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, false);
    assertStringIncludes(result.message, "exited 3");
    assertStringIncludes(result.message, "CAUSE-HEAD");
    assertStringIncludes(result.message, "CAUSE-TAIL");
    assertStringIncludes(result.message, " … ");
    assertEquals(result.message.includes("fixture-middle-secret"), false);
    assert(
      result.message.length < 700,
      `message too long: ${result.message.length}`,
    );
    assertEquals(await exists(paths.response), false);
  });
});

Deno.test("the provider choice is handed the repair's own log seam", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness();

    await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(h.chooseCalls[0]!.log, h.deps.log);
    h.chooseCalls[0]!.log?.("from the provider choice");
    assertStringIncludes(h.logs.join("\n"), "from the provider choice");
  });
});

Deno.test("a non-Error throw is reported as its string form, an Error as its message", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness();
    h.deps.chooseProvider = () => Promise.reject("plain string cause");

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.message, "provider choice failed: plain string cause");

    const e = harness(new Error("error object cause"));
    const errorResult = await runBabysitterRepair(
      argsFor(paths),
      CONFIG,
      e.deps,
    );
    assertEquals(
      errorResult.message,
      "provider choice failed: error object cause",
    );
  });
});

Deno.test("production deps use real files, the real provider choice and runner, and stderr logging", async () => {
  const deps = productionBabysitterRepairDeps;
  assertEquals(deps.chooseProvider, chooseBabysitterProvider);
  assertEquals(
    deps.exportSubscriptionCredentials,
    exportBabysitterSubscriptionCredentials,
  );
  assertEquals(deps.runClaude, runClaudeWithTimeout);
  assertEquals(deps.treeGate, runBabysitterTreeGate);

  await inWorkspace(async (paths) => {
    const file = `${paths.root}/prod.txt`;
    await deps.writeTextFile(file, "PROD TEXT");
    assertEquals(await deps.readTextFile(file), "PROD TEXT");
    assertEquals(await Deno.readTextFile(file), "PROD TEXT");
    await deps.removeFile(file);
    assertEquals(await exists(file), false);
  });

  const original = console.error;
  const seen: unknown[][] = [];
  console.error = (...a: unknown[]) => {
    seen.push(a);
  };
  try {
    deps.log("prod log line");
  } finally {
    console.error = original;
  }
  assertEquals(seen, [["prod log line"]]);
});

// Issue #5072: the repair container never loaded the subscription logins, so
// every automatic choice read claude/codex as billing-unknown and went to paid
// DeepSeek overflow. The logins must be in the environment before the choice.
Deno.test("subscription credentials are exported before the provider choice (Issue #5072)", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness();

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, true);
    assertEquals(h.order, ["export", "choose"]);
    assertEquals(h.exportCalls[0]!.enabledProviderIds, [
      "claude",
      "codex",
      "deepseek",
    ]);
  });
});

Deno.test("a failed subscription credential export stops before any provider is chosen (Issue #5072)", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness();
    h.deps.exportSubscriptionCredentials = () =>
      Promise.reject(new Error("credential dir unreadable"));

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, false);
    assertStringIncludes(
      result.message,
      "subscription credential export failed: credential dir unreadable",
    );
    assertEquals(h.chooseCalls.length, 0);
    assertEquals(h.runs.length, 0);
  });
});

Deno.test("production export loads the Claude and Codex logins but never DeepSeek's (Issue #5072)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "babysitter-creds-5072-" });
  try {
    await Deno.mkdir(`${dir}/claude`);
    await Deno.writeTextFile(
      `${dir}/claude/provider.env`,
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fixture\n",
    );
    await Deno.mkdir(`${dir}/deepseek`);
    await Deno.writeTextFile(
      `${dir}/deepseek/provider.env`,
      "DEEPSEEK_API_KEY=sk-deepseek-fixture\n",
    );
    const set: Record<string, string> = {};
    const exported = await exportBabysitterSubscriptionCredentials({
      enabledProviderIds: ["claude", "deepseek"],
      log: () => {},
      dir,
      env: (name) => set[name],
      setEnv: (name, value) => set[name] = value,
    });

    assertEquals(exported, ["CLAUDE_CODE_OAUTH_TOKEN"]);
    assertEquals(set["CLAUDE_CODE_OAUTH_TOKEN"], "sk-ant-oat01-fixture");
    assertEquals(set["DEEPSEEK_API_KEY"], undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a quota-exhausted agent exits with the reserved park status (Issue #5072)", async () => {
  await inWorkspace(async (paths) => {
    await writePrompt(paths);
    const h = harness(
      CLAUDE_CHOICE,
      finished({
        exitCode: 1,
        stderr: "",
        agentFailure: {
          category: "quota-exhausted",
          message: "DeepSeek's account balance is spent",
          evidence: "structured",
          terminal: true,
          errors: [],
        },
      }),
    );

    const result = await runBabysitterRepair(argsFor(paths), CONFIG, h.deps);

    assertEquals(result.success, false);
    assertEquals(result.exitCode, BABYSITTER_QUOTA_PARK_EXIT_CODE);
    assertStringIncludes(result.message, "quota-exhausted");
    assertEquals(await exists(paths.response), false);
  });
});
