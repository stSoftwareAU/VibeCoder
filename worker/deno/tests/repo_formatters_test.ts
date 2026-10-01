/**
 * Tests for `repo_formatters.ts` (Issue #2967).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  outermostConfigDirs,
  type RepoFormatterDeps,
  runRepoFormatters,
} from "../lib/repo_formatters.ts";
import type {
  GitCommandOptions,
  GitCommandOutput,
} from "../lib/git_timeout.ts";
import type { Result } from "../types.ts";
import type { Logger } from "../types.ts";

const REPO_PATH = "/repo";

interface CommandCall {
  cmd: string[];
  cwd?: string;
}

interface ScriptedCommand {
  exitCode: number;
  output?: string;
  /** When true, bumps the fake tree state so the next diff differs. */
  changesTree?: boolean;
}

/** A recording logger implementing every Logger method. */
function makeRecordingLogger(): Logger & { infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    info: (message) => {
      infos.push(message);
    },
    warn: (message) => {
      warns.push(message);
    },
    error: () => {},
    debug: () => {},
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
}

/** Builds fakes around a given tracked file list and scripted formatter runs. */
function makeDeps(
  files: string[],
  scripted: Record<string, ScriptedCommand> = {},
) {
  const commandCalls: CommandCall[] = [];
  const gitCalls: { args: string[]; options?: GitCommandOptions }[] = [];
  let treeState = 0;
  const logger = makeRecordingLogger();

  const runCommand: RepoFormatterDeps["runCommand"] = (cmd, options) => {
    commandCalls.push({ cmd, cwd: options?.cwd });
    const key = cmd.join(" ");
    const script = scripted[key] ?? { exitCode: 0 };
    if (script.changesTree) treeState++;
    return Promise.resolve({
      exitCode: script.exitCode,
      output: script.output ?? "",
    });
  };

  const fakeRunGitCommand = (
    args: string[],
    options?: GitCommandOptions,
  ): Promise<Result<GitCommandOutput>> => {
    gitCalls.push({ args, options });
    if (args[0] === "ls-files") {
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout: files.join("\0"), stderr: "" },
      });
    }
    if (args[0] === "diff") {
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout: `tree-${treeState}`, stderr: "" },
      });
    }
    if (args[0] === "add" || args[0] === "commit") {
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout: "", stderr: "" },
      });
    }
    return Promise.resolve({
      ok: true,
      value: { code: 0, stdout: "", stderr: "" },
    });
  };

  const deps: RepoFormatterDeps = {
    runCommand,
    runGitCommand: fakeRunGitCommand,
    logger,
    runId: () => "test-run-id",
  };

  return { deps, commandCalls, gitCalls, logger };
}

Deno.test("repo formatters - only root Cargo.toml runs cargo fmt at root", async () => {
  const { deps, commandCalls } = makeDeps(["Cargo.toml", "src/main.rs"]);
  await runRepoFormatters(REPO_PATH, deps);
  const cargoCalls = commandCalls.filter((c) => c.cmd[0] === "cargo");
  const denoCalls = commandCalls.filter((c) => c.cmd[0] === "deno");
  assertEquals(cargoCalls.length, 1);
  assertEquals(cargoCalls[0]?.cmd, ["cargo", "fmt", "--all"]);
  assertEquals(cargoCalls[0]?.cwd, REPO_PATH);
  assertEquals(denoCalls.length, 0);
});

Deno.test("repo formatters - only web/deno.json runs deno fmt at web", async () => {
  const { deps, commandCalls } = makeDeps(["web/deno.json", "web/main.ts"]);
  await runRepoFormatters(REPO_PATH, deps);
  const denoCalls = commandCalls.filter((c) => c.cmd[0] === "deno");
  const cargoCalls = commandCalls.filter((c) => c.cmd[0] === "cargo");
  assertEquals(denoCalls.length, 1);
  assertEquals(denoCalls[0]?.cmd, ["deno", "fmt"]);
  assertEquals(denoCalls[0]?.cwd, `${REPO_PATH}/web`);
  assertEquals(cargoCalls.length, 0);
});

Deno.test("repo formatters - deno.json and web/deno.jsonc runs deno fmt once at root", async () => {
  const { deps, commandCalls } = makeDeps(["deno.json", "web/deno.jsonc"]);
  await runRepoFormatters(REPO_PATH, deps);
  const denoCalls = commandCalls.filter((c) => c.cmd[0] === "deno");
  assertEquals(denoCalls.length, 1);
  assertEquals(denoCalls[0]?.cwd, REPO_PATH);
});

Deno.test("repo formatters - root Cargo.toml and web/deno.json run both", async () => {
  const { deps, commandCalls } = makeDeps(["Cargo.toml", "web/deno.json"]);
  await runRepoFormatters(REPO_PATH, deps);
  const cargoCalls = commandCalls.filter((c) => c.cmd[0] === "cargo");
  const denoCalls = commandCalls.filter((c) => c.cmd[0] === "deno");
  assertEquals(cargoCalls.length, 1);
  assertEquals(cargoCalls[0]?.cwd, REPO_PATH);
  assertEquals(denoCalls.length, 1);
  assertEquals(denoCalls[0]?.cwd, `${REPO_PATH}/web`);
});

Deno.test("repo formatters - neither config present runs nothing and does not commit", async () => {
  const { deps, commandCalls, gitCalls } = makeDeps(["README.md"]);
  const result = await runRepoFormatters(REPO_PATH, deps);
  assertEquals(commandCalls.length, 0);
  assertEquals(gitCalls.some((c) => c.args[0] === "add"), false);
  assertEquals(gitCalls.some((c) => c.args[0] === "commit"), false);
  assertEquals(result.committed, false);
});

Deno.test("repo formatters - formatter that changes files commits once", async () => {
  const { deps, gitCalls } = makeDeps(["Cargo.toml"], {
    "cargo fmt --all": { exitCode: 0, changesTree: true },
  });
  const result = await runRepoFormatters(REPO_PATH, deps);

  const addCalls = gitCalls.filter((c) => c.args[0] === "add");
  const commitCalls = gitCalls.filter((c) => c.args[0] === "commit");
  assertEquals(addCalls.length, 1);
  assertEquals(commitCalls.length, 1);

  const commitIndex = gitCalls.indexOf(commitCalls[0]!);
  const addIndex = gitCalls.indexOf(addCalls[0]!);
  assert(addIndex < commitIndex, "git add -u must run before git commit");

  const message = commitCalls[0]?.args[2] ?? "";
  assert(message.startsWith("style: apply repository formatters"));
  assertStringIncludes(message, "Vibe-Coder-Run-Id: test-run-id");

  assertEquals(result.committed, true);
  assertEquals(result.runs[0]?.changed, true);
});

Deno.test("repo formatters - formatter that changes nothing does not commit", async () => {
  const { deps, gitCalls } = makeDeps(["Cargo.toml"], {
    "cargo fmt --all": { exitCode: 0 },
  });
  const result = await runRepoFormatters(REPO_PATH, deps);
  assertEquals(gitCalls.some((c) => c.args[0] === "add"), false);
  assertEquals(gitCalls.some((c) => c.args[0] === "commit"), false);
  assertEquals(result.committed, false);
});

Deno.test("repo formatters - non-zero exit is recorded, redacted, logged, and never throws", async () => {
  const secret = "ghp_" + "a".repeat(36);
  const { deps, logger } = makeDeps(["Cargo.toml"], {
    "cargo fmt --all": {
      exitCode: 127,
      output: `NotFound: cargo: No such file or directory ${secret}`,
    },
  });
  const result = await runRepoFormatters(REPO_PATH, deps);
  assertEquals(result.failures.length, 1);
  assertEquals(result.failures[0]?.tool, "cargo fmt");
  assertEquals(result.failures[0]?.dir, ".");
  assert(!result.failures[0]?.excerpt?.includes(secret));
  assert(
    logger.warns.some((w) => w.includes("cargo fmt") && w.includes(".")),
    "expected a warn naming the tool and directory",
  );
});

Deno.test("repo formatters - ls-files git failure resolves with gitError and no runCommand calls", async () => {
  const commandCalls: CommandCall[] = [];
  const logger = makeRecordingLogger();
  const deps: RepoFormatterDeps = {
    runCommand: (cmd, options) => {
      commandCalls.push({ cmd, cwd: options?.cwd });
      return Promise.resolve({ exitCode: 0, output: "" });
    },
    runGitCommand: () =>
      Promise.resolve({ ok: false, error: new Error("ls-files boom") }),
    logger,
    runId: () => "test-run-id",
  };
  const result = await runRepoFormatters(REPO_PATH, deps);
  assertEquals(result.gitError, "ls-files boom");
  assertEquals(commandCalls.length, 0);
  assert(logger.warns.length > 0, "expected a warn on ls-files failure");
});

Deno.test("repo formatters - snapshot failure after a formatter fails loud with no add/commit", async () => {
  const commandCalls: CommandCall[] = [];
  const gitCalls: { args: string[]; options?: GitCommandOptions }[] = [];
  const logger = makeRecordingLogger();
  let diffCalls = 0;
  const deps: RepoFormatterDeps = {
    runCommand: (cmd, options) => {
      commandCalls.push({ cmd, cwd: options?.cwd });
      return Promise.resolve({ exitCode: 0, output: "" });
    },
    runGitCommand: (args, options) => {
      gitCalls.push({ args, options });
      if (args[0] === "ls-files") {
        return Promise.resolve({
          ok: true,
          value: { code: 0, stdout: "Cargo.toml", stderr: "" },
        });
      }
      if (args[0] === "diff") {
        diffCalls++;
        if (diffCalls === 1) {
          return Promise.resolve({
            ok: true,
            value: { code: 0, stdout: "tree-0", stderr: "" },
          });
        }
        return Promise.resolve({
          ok: false,
          error: new Error("diff boom"),
        });
      }
      return Promise.resolve({
        ok: true,
        value: { code: 0, stdout: "", stderr: "" },
      });
    },
    logger,
    runId: () => "test-run-id",
  };

  const result = await runRepoFormatters(REPO_PATH, deps);

  assertEquals(result.gitError, "diff boom");
  assertEquals(result.committed, false);
  assertEquals(result.runs.length, 1);
  assertEquals(result.runs[0]?.changed, false);
  assertEquals(gitCalls.some((c) => c.args[0] === "add"), false);
  assertEquals(gitCalls.some((c) => c.args[0] === "commit"), false);
  assert(
    logger.warns.some((w) => w.includes("diff boom")),
    "expected a warn on the mid-loop snapshot failure",
  );
});

Deno.test("outermostConfigDirs - nested Cargo.toml under a kept ancestor is dropped", () => {
  const dirs = outermostConfigDirs(
    ["a/Cargo.toml", "a/b/Cargo.toml"],
    ["Cargo.toml"],
  );
  assertEquals(dirs, ["a"]);
});

Deno.test("outermostConfigDirs - sibling-looking dirs with a shared prefix are both kept", () => {
  const dirs = outermostConfigDirs(
    ["web/deno.json", "webx/deno.json"],
    ["deno.json", "deno.jsonc"],
  );
  assertEquals(dirs, ["web", "webx"]);
});
