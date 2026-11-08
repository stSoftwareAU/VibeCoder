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
  runBabysitterRepair,
} from "../commands/babysitter_repair.ts";
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
): Harness {
  const runs: RunClaudeOptions[] = [];
  const chooseCalls: BabysitterProviderChoiceDeps[] = [];
  const logs: string[] = [];
  const deps: BabysitterRepairDeps = {
    readTextFile: (path) => Deno.readTextFile(path),
    writeTextFile: (path, text) => Deno.writeTextFile(path, text),
    removeFile: (path) => Deno.remove(path),
    chooseProvider: async (choiceDeps) => {
      chooseCalls.push(choiceDeps);
      if (choice instanceof Error) throw choice;
      return choice;
    },
    runClaude: async (options) => {
      runs.push(options);
      return run;
    },
    log: (message) => logs.push(message),
  };
  return { deps, runs, chooseCalls, logs };
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
    assertEquals(h.runs.length, 0);
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
