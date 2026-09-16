/**
 * Tests for the CodeGraph repo-context runner (Issue #2155, part of #2145).
 *
 * Every test injects the `run` and `git` seams, so nothing here spawns a
 * process: the `codegraph` binary is a runtime prerequisite of an enabled
 * host, never of the test suite. The temp directory stands in for the
 * checkout, and the fake git answers `rev-parse --git-path info/exclude` with
 * the path the real one would.
 *
 * Fail direction, stated explicitly: with the failure handling removed —
 * a non-zero exit, a timeout or a spawn rejection propagating instead of being
 * reported — the three `failed` tests go red, because they assert both the
 * status and that exactly one `[CODEGRAPH_UNAVAILABLE]` line was logged.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Result } from "../types.ts";
import type { SubprocessResult } from "../lib/subprocess_timeout.ts";
import type { GitCommandOutput } from "../lib/git_timeout.ts";
import { EXECUTABLE_IGNORED_DIRS } from "../lib/ignored_path_clean.ts";
import { GEMINI_PROVIDER_ID } from "../lib/agent_provider.ts";
import {
  CODEGRAPH_EXCLUDE_PATTERN,
  CODEGRAPH_INDEX_DIR,
  CODEGRAPH_INDEX_TIMEOUT_MS,
  CODEGRAPH_LAYOUT_DIRS,
  CODEGRAPH_PROMPT_LINE,
  CODEGRAPH_UNAVAILABLE_MARKER,
  type CodegraphGitRunner,
  codegraphMcpServer,
  type CodegraphRunner,
  countCodegraphQueries,
  prepareCodegraphContext,
} from "../lib/codegraph_context.ts";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** One recorded subprocess invocation. */
interface RunCall {
  executable: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** A `SubprocessResult` with the defaults of a clean exit. */
function ok(overrides: Partial<SubprocessResult> = {}): SubprocessResult {
  return {
    success: true,
    code: 0,
    stdout: "",
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

/** Status JSON in the shape `codegraph status --json` prints (v1.6.0). */
function statusJson(nodeCount: number, edgeCount: number): string {
  return JSON.stringify({
    initialized: true,
    version: "1.6.0",
    fileCount: 12,
    nodeCount,
    edgeCount,
    backend: "node:sqlite",
    journalMode: "wal",
  });
}

/**
 * A `run` seam that answers per subcommand and records every call.
 *
 * `answers` is keyed by the first argument (`init`, `sync`, `status`); an
 * answer may be a result, or a function that throws to model a seam that
 * rejects.
 */
function fakeRun(
  answers: Record<
    string,
    Result<SubprocessResult> | (() => Promise<Result<SubprocessResult>>)
  >,
): { run: CodegraphRunner; calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run: CodegraphRunner = (executable, args, options) => {
    calls.push({
      executable,
      args,
      cwd: options?.cwd,
      env: options?.env,
      timeoutMs: options?.timeoutMs,
    });
    const answer = answers[args[0] ?? ""];
    if (answer === undefined) {
      return Promise.resolve({
        ok: true,
        value: ok(),
      } as Result<SubprocessResult>);
    }
    return typeof answer === "function" ? answer() : Promise.resolve(answer);
  };
  return { run, calls };
}

/** A `git` seam answering `rev-parse --git-path info/exclude`. */
function fakeGit(
  answer: Partial<GitCommandOutput> = {},
): { git: CodegraphGitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const git: CodegraphGitRunner = (args) => {
    calls.push(args);
    return Promise.resolve({
      ok: true,
      value: {
        code: 0,
        stdout: ".git/info/exclude\n",
        stderr: "",
        ...answer,
      },
    });
  };
  return { git, calls };
}

/** A logger that records only what this module logs. */
function fakeLogger(): { warn: (message: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { warn: (message: string) => lines.push(message), lines };
}

/** Seams that fail the test if anything reaches them. */
function forbiddenSeams(): { run: CodegraphRunner; git: CodegraphGitRunner } {
  return {
    run: () => {
      throw new Error("run must not be called");
    },
    git: () => {
      throw new Error("git must not be called");
    },
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "codegraph_context_test_" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Read the exclude file the fake git points at. */
async function readExclude(dir: string): Promise<string> {
  return await Deno.readTextFile(`${dir}/.git/info/exclude`);
}

/** Marker lines in a logger's output. */
function markerLines(lines: string[]): string[] {
  return lines.filter((line) => line.startsWith(CODEGRAPH_UNAVAILABLE_MARKER));
}

// ---------------------------------------------------------------------------
// Short circuits — nothing is spawned
// ---------------------------------------------------------------------------

Deno.test("prepareCodegraphContext - the switch off returns off without spawning", async () => {
  const logger = fakeLogger();
  const result = await prepareCodegraphContext({
    repoDir: "/nonexistent",
    enabled: false,
    providerId: "claude",
    logger,
    ...forbiddenSeams(),
  });

  assertEquals(result, { status: "off", enabled: false });
  assertEquals(logger.lines, []);
});

Deno.test("prepareCodegraphContext - a Gemini run is unsupported and spawns nothing", async () => {
  const logger = fakeLogger();
  const result = await prepareCodegraphContext({
    repoDir: "/nonexistent",
    enabled: true,
    providerId: GEMINI_PROVIDER_ID,
    logger,
    ...forbiddenSeams(),
  });

  assertEquals(result, { status: "unsupported", enabled: true });
  assertEquals(logger.lines, []);
});

// ---------------------------------------------------------------------------
// init vs sync, and how they are invoked
// ---------------------------------------------------------------------------

Deno.test("prepareCodegraphContext - an absent index is built with init", async () => {
  await withTempDir(async (dir) => {
    const { run, calls } = fakeRun({
      status: { ok: true, value: ok({ stdout: statusJson(10, 4) }) },
    });
    const result = await prepareCodegraphContext({
      repoDir: dir,
      enabled: true,
      providerId: "claude",
      logger: fakeLogger(),
      run,
      git: fakeGit().git,
    });

    assertEquals(result.status, "ok");
    assertEquals(calls[0]?.executable, "codegraph");
    assertEquals(calls[0]?.args, ["init", "--yes"]);
    assertEquals(calls[0]?.cwd, dir);
  });
});

Deno.test("prepareCodegraphContext - a present index is refreshed with sync", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(`${dir}/${CODEGRAPH_INDEX_DIR}`);
    const { run, calls } = fakeRun({
      status: { ok: true, value: ok({ stdout: statusJson(10, 4) }) },
    });
    const result = await prepareCodegraphContext({
      repoDir: dir,
      enabled: true,
      providerId: "claude",
      logger: fakeLogger(),
      run,
      git: fakeGit().git,
    });

    assertEquals(result.status, "ok");
    assertEquals(calls[0]?.args, ["sync"]);
  });
});

Deno.test("prepareCodegraphContext - the index step carries CODEGRAPH_NO_DAEMON and the 300 s limit", async () => {
  await withTempDir(async (dir) => {
    const { run, calls } = fakeRun({
      status: { ok: true, value: ok({ stdout: statusJson(1, 1) }) },
    });
    await prepareCodegraphContext({
      repoDir: dir,
      enabled: true,
      providerId: "claude",
      logger: fakeLogger(),
      run,
      git: fakeGit().git,
    });

    assertEquals(calls[0]?.env, { CODEGRAPH_NO_DAEMON: "1" });
    assertEquals(calls[0]?.timeoutMs, CODEGRAPH_INDEX_TIMEOUT_MS);
    assertEquals(CODEGRAPH_INDEX_TIMEOUT_MS, 300_000);
    // The figures read carries the same environment.
    assertEquals(calls[1]?.env, { CODEGRAPH_NO_DAEMON: "1" });
  });
});

Deno.test("prepareCodegraphContext - an explicit index limit overrides the default", async () => {
  await withTempDir(async (dir) => {
    const { run, calls } = fakeRun({
      status: { ok: true, value: ok({ stdout: statusJson(1, 1) }) },
    });
    await prepareCodegraphContext({
      repoDir: dir,
      enabled: true,
      providerId: "claude",
      logger: fakeLogger(),
      run,
      git: fakeGit().git,
      indexTimeoutMs: 1_000,
    });

    assertEquals(calls[0]?.timeoutMs, 1_000);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

Deno.test("prepareCodegraphContext - reports the node and relationship counts", async () => {
  await withTempDir(async (dir) => {
    const { run } = fakeRun({
      status: { ok: true, value: ok({ stdout: statusJson(4_321, 9_876) }) },
    });
    const logger = fakeLogger();
    const result = await prepareCodegraphContext({
      repoDir: dir,
      enabled: true,
      providerId: "claude",
      logger,
      run,
      git: fakeGit().git,
    });

    assertEquals(result.status, "ok");
    assertEquals(result.enabled, true);
    assertEquals(result.nodeCount, 4_321);
    assertEquals(result.relationshipCount, 9_876);
    assert(
      typeof result.indexSeconds === "number" && result.indexSeconds >= 0,
      `expected index seconds, got ${result.indexSeconds}`,
    );
    // `queries` is the wiring's to set after the run, not this module's.
    assertEquals(result.queries, undefined);
    assertEquals(logger.lines, []);
  });
});

// ---------------------------------------------------------------------------
// Failure modes — one marker line, never a throw
// ---------------------------------------------------------------------------

Deno.test("prepareCodegraphContext - a non-zero exit fails with one marker line", async () => {
  await withTempDir(async (dir) => {
    const logger = fakeLogger();
    const { run } = fakeRun({
      init: {
        ok: true,
        value: ok({ success: false, code: 2, stderr: "index refused" }),
      },
    });
    const result = await prepareCodegraphContext({
      repoDir: dir,
      enabled: true,
      providerId: "claude",
      logger,
      run,
      git: fakeGit().git,
    });

    assertEquals(result.status, "failed");
    assertEquals(result.enabled, true);
    assertEquals(result.nodeCount, undefined);
    assert(typeof result.indexSeconds === "number");
    assertEquals(markerLines(logger.lines).length, 1);
    assertStringIncludes(logger.lines[0]!, "exited 2");
    assertStringIncludes(logger.lines[0]!, "index refused");
  });
});

Deno.test("prepareCodegraphContext - a timeout fails with one marker line", async () => {
  await withTempDir(async (dir) => {
    const logger = fakeLogger();
    const { run } = fakeRun({
      init: {
        ok: true,
        value: ok({ success: false, code: 124, timedOut: true }),
      },
    });
    const result = await prepareCodegraphContext({
      repoDir: dir,
      enabled: true,
      providerId: "claude",
      logger,
      run,
      git: fakeGit().git,
      indexTimeoutMs: 1_234,
    });

    assertEquals(result.status, "failed");
    assertEquals(markerLines(logger.lines).length, 1);
    assertStringIncludes(logger.lines[0]!, "timed out after 1234ms");
  });
});

Deno.test("prepareCodegraphContext - a rejecting spawn seam fails without throwing", async () => {
  await withTempDir(async (dir) => {
    const logger = fakeLogger();
    const { run } = fakeRun({
      init: () => Promise.reject(new Error("spawn codegraph ENOENT")),
    });
    const result = await prepareCodegraphContext({
      repoDir: dir,
      enabled: true,
      providerId: "claude",
      logger,
      run,
      git: fakeGit().git,
    });

    assertEquals(result.status, "failed");
    assertEquals(markerLines(logger.lines).length, 1);
    assertStringIncludes(logger.lines[0]!, "could not be started");
    assertStringIncludes(logger.lines[0]!, "ENOENT");
  });
});

Deno.test("prepareCodegraphContext - a missing binary fails with one marker line", async () => {
  await withTempDir(async (dir) => {
    const logger = fakeLogger();
    const { run } = fakeRun({
      init: { ok: false, error: new Error("No such file or directory") },
    });
    const result = await prepareCodegraphContext({
      repoDir: dir,
      enabled: true,
      providerId: "claude",
      logger,
      run,
      git: fakeGit().git,
    });

    assertEquals(result.status, "failed");
    assertEquals(markerLines(logger.lines).length, 1);
    assertStringIncludes(logger.lines[0]!, "is the codegraph binary installed");
  });
});

Deno.test("prepareCodegraphContext - unreadable counts fail rather than report zero", async () => {
  await withTempDir(async (dir) => {
    const logger = fakeLogger();
    const { run } = fakeRun({
      status: {
        ok: true,
        value: ok({ stdout: JSON.stringify({ initialized: false }) }),
      },
    });
    const result = await prepareCodegraphContext({
      repoDir: dir,
      enabled: true,
      providerId: "claude",
      logger,
      run,
      git: fakeGit().git,
    });

    assertEquals(result.status, "failed");
    assertEquals(result.nodeCount, undefined);
    assertEquals(result.relationshipCount, undefined);
    assert(typeof result.indexSeconds === "number");
    assertEquals(markerLines(logger.lines).length, 1);
    assertStringIncludes(logger.lines[0]!, "nodeCount");
  });
});

Deno.test("prepareCodegraphContext - unparseable status output fails loud", async () => {
  await withTempDir(async (dir) => {
    const logger = fakeLogger();
    const { run } = fakeRun({
      status: { ok: true, value: ok({ stdout: "CodeGraph Status\n\n" }) },
    });
    const result = await prepareCodegraphContext({
      repoDir: dir,
      enabled: true,
      providerId: "claude",
      logger,
      run,
      git: fakeGit().git,
    });

    assertEquals(result.status, "failed");
    assertEquals(markerLines(logger.lines).length, 1);
    assertStringIncludes(logger.lines[0]!, "could not be parsed");
  });
});

Deno.test("prepareCodegraphContext - an unresolvable exclude file fails before any index step", async () => {
  await withTempDir(async (dir) => {
    const logger = fakeLogger();
    const { run, calls } = fakeRun({});
    const result = await prepareCodegraphContext({
      repoDir: dir,
      enabled: true,
      providerId: "claude",
      logger,
      run,
      git: fakeGit({ code: 128, stdout: "", stderr: "not a git repository" })
        .git,
    });

    assertEquals(result.status, "failed");
    assertEquals(calls, []);
    assertEquals(markerLines(logger.lines).length, 1);
    assertStringIncludes(logger.lines[0]!, "info/exclude");
  });
});

// ---------------------------------------------------------------------------
// `.codegraph/` persistence
// ---------------------------------------------------------------------------

Deno.test("prepareCodegraphContext - appends the exclude pattern once across runs", async () => {
  await withTempDir(async (dir) => {
    const { run } = fakeRun({
      status: { ok: true, value: ok({ stdout: statusJson(1, 1) }) },
    });
    const options = {
      repoDir: dir,
      enabled: true,
      providerId: "claude",
      logger: fakeLogger(),
      run,
      git: fakeGit().git,
    };

    await prepareCodegraphContext(options);
    await prepareCodegraphContext(options);

    const lines = (await readExclude(dir)).split("\n")
      .filter((line) => line.trim() === CODEGRAPH_EXCLUDE_PATTERN);
    assertEquals(lines.length, 1);
    assertEquals(CODEGRAPH_EXCLUDE_PATTERN, "/.codegraph/");
  });
});

Deno.test("prepareCodegraphContext - keeps existing exclude content and its newline", async () => {
  await withTempDir(async (dir) => {
    await Deno.mkdir(`${dir}/.git/info`, { recursive: true });
    // No trailing newline: the append must not join the two patterns.
    await Deno.writeTextFile(`${dir}/.git/info/exclude`, "*.log");
    const { run } = fakeRun({
      status: { ok: true, value: ok({ stdout: statusJson(1, 1) }) },
    });

    await prepareCodegraphContext({
      repoDir: dir,
      enabled: true,
      providerId: "claude",
      logger: fakeLogger(),
      run,
      git: fakeGit().git,
    });

    assertEquals(await readExclude(dir), "*.log\n/.codegraph/\n");
  });
});

Deno.test("no `.codegraph/` layout directory is erased by the ignored-path clean", () => {
  for (const dir of CODEGRAPH_LAYOUT_DIRS) {
    assertEquals(
      EXECUTABLE_IGNORED_DIRS.includes(dir),
      false,
      `${dir} would be erased by the scoped ignored clean`,
    );
  }
});

// ---------------------------------------------------------------------------
// MCP entry, prompt line and the query tally
// ---------------------------------------------------------------------------

Deno.test("codegraphMcpServer - names only the keys Claude and Codex both translate", () => {
  const server = codegraphMcpServer();
  assertEquals(server, {
    command: "codegraph",
    args: ["serve", "--mcp"],
    env: { CODEGRAPH_NO_DAEMON: "1" },
  });
  assertEquals(Object.keys(server).sort(), ["args", "command", "env"]);
});

Deno.test("codegraphMcpServer - a mutated entry does not leak into the next call", () => {
  const first = codegraphMcpServer();
  first.args.push("--rogue");
  first.env.CODEGRAPH_NO_DAEMON = "0";
  assertEquals(codegraphMcpServer().args, ["serve", "--mcp"]);
  assertEquals(codegraphMcpServer().env, { CODEGRAPH_NO_DAEMON: "1" });
});

Deno.test("CODEGRAPH_PROMPT_LINE - is exactly one line naming the tool", () => {
  assertEquals(CODEGRAPH_PROMPT_LINE.includes("\n"), false);
  assertEquals(CODEGRAPH_PROMPT_LINE.includes("\r"), false);
  assertEquals(CODEGRAPH_PROMPT_LINE.trim(), CODEGRAPH_PROMPT_LINE);
  assertStringIncludes(CODEGRAPH_PROMPT_LINE, "codegraph_explore");
});

Deno.test("countCodegraphQueries - counts the bare tool name", () => {
  assertEquals(countCodegraphQueries({ codegraph_explore: 3, Read: 9 }), 3);
});

Deno.test("countCodegraphQueries - counts the Claude MCP tool name", () => {
  assertEquals(
    countCodegraphQueries({ mcp__codegraph__codegraph_explore: 5 }),
    5,
  );
});

Deno.test("countCodegraphQueries - sums both spellings in one tally", () => {
  assertEquals(
    countCodegraphQueries({
      codegraph_explore: 2,
      mcp__codegraph__codegraph_explore: 4,
      mcp__playwright__browser_navigate: 7,
    }),
    6,
  );
});

Deno.test("countCodegraphQueries - a tally without a CodeGraph call counts zero", () => {
  assertEquals(countCodegraphQueries({ Read: 4, Bash: 2 }), 0);
  assertEquals(countCodegraphQueries({}), 0);
});

Deno.test("countCodegraphQueries - no tally at all is undefined, not zero", () => {
  assertEquals(countCodegraphQueries(), undefined);
  assertEquals(countCodegraphQueries(undefined), undefined);
});

Deno.test("countCodegraphQueries - a look-alike tool name is not counted", () => {
  assertEquals(
    countCodegraphQueries({
      codegraph_explorer: 3,
      explore: 2,
      codegraph_explore_all: 4,
    }),
    0,
  );
});
