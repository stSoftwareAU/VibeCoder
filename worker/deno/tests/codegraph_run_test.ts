/**
 * Tests for `lib/codegraph_run.ts` — turning a CodeGraph preparation into the
 * decisions one agent run makes (Issue #2159, part of #2145).
 *
 * The invariant under test is that the MCP entry and the prompt line are
 * added together or not at all, for every status the preparation can report.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CODEGRAPH_PROMPT_LINE,
  type CodegraphContextResult,
  type PrepareCodegraphContextOptions,
} from "../lib/codegraph_context.ts";
import {
  type CodegraphRunLogger,
  prepareCodegraphRun,
} from "../lib/codegraph_run.ts";
import {
  assertCodegraphRootedAt,
  codegraphServerRoot,
} from "./support/codegraph_mcp_root.ts";

/** A logger that keeps what it was told, so a test can read the status line. */
function recordingLogger(): CodegraphRunLogger & {
  info: (m: string) => void;
  lines: { level: string; message: string }[];
} {
  const lines: { level: string; message: string }[] = [];
  return {
    lines,
    info: (message: string) => lines.push({ level: "info", message }),
    warn: (message: string) => lines.push({ level: "warn", message }),
  };
}

/** A preparer that records its call and answers with a fixed result. */
function fakePreparer(result: CodegraphContextResult) {
  const calls: PrepareCodegraphContextOptions[] = [];
  return {
    calls,
    prepare: (options: PrepareCodegraphContextOptions) => {
      calls.push(options);
      return Promise.resolve(result);
    },
  };
}

Deno.test("prepareCodegraphRun - a switched-off host changes nothing", async () => {
  const logger = recordingLogger();
  const preparer = fakePreparer({ status: "off", enabled: false });
  const run = await prepareCodegraphRun({
    repoDir: "/tmp/checkout",
    enabled: false,
    logger,
    prepare: preparer.prepare,
  });

  assertEquals(run.result.status, "off");
  assertEquals(run.applyPrompt("the prompt"), "the prompt");
  assertEquals(run.mcpConfig(true), true);
  assertEquals(run.mcpConfig(false), false);
  assertEquals(run.mcpConfig(), undefined);
  assertEquals(preparer.calls[0]?.enabled, false);
  assertEquals(preparer.calls[0]?.repoDir, "/tmp/checkout");
});

Deno.test("prepareCodegraphRun - an indexed run gains the line and the server", async () => {
  const logger = recordingLogger();
  const preparer = fakePreparer({
    status: "ok",
    enabled: true,
    indexSeconds: 12.5,
    nodeCount: 4821,
    relationshipCount: 15903,
  });
  const run = await prepareCodegraphRun({
    repoDir: "/tmp/checkout",
    enabled: true,
    logger,
    prepare: preparer.prepare,
  });

  const prompt = run.applyPrompt("the prompt");
  assertStringIncludes(prompt, CODEGRAPH_PROMPT_LINE);
  assertEquals(
    prompt.split(CODEGRAPH_PROMPT_LINE).length - 1,
    1,
    "the line must appear exactly once",
  );
  assert(prompt.startsWith("the prompt"), "the built prompt must be preserved");

  const mcp = run.mcpConfig(false);
  assert(typeof mcp === "object", "an indexed run must name its servers");
  assertEquals(mcp.playwright, false);
  assertEquals(mcp.servers?.codegraph?.command, "codegraph");
  assertEquals(mcp.servers?.codegraph?.args, [
    "serve",
    "--mcp",
    "--path",
    "/tmp/checkout",
  ]);
  // The root is the checkout the index was built in, never the agent's own
  // working directory (Issue #2200).
  assertCodegraphRootedAt(mcp, preparer.calls[0]?.repoDir, "codegraph_run");
  // The browser grant it already had is preserved, never widened.
  const withBrowser = run.mcpConfig(true);
  assert(typeof withBrowser === "object");
  assertEquals(withBrowser.playwright, true);

  const line = logger.lines.find((l) => l.message.startsWith("CodeGraph"));
  assert(line, "one status line must be logged per run");
  assertStringIncludes(line.message, "status=ok");
  assertStringIncludes(line.message, "nodes=4821");
  assertStringIncludes(line.message, "relationships=15903");
});

Deno.test("prepareCodegraphRun - a failed index adds neither half", async () => {
  for (const status of ["failed", "unsupported"] as const) {
    const logger = recordingLogger();
    const preparer = fakePreparer({ status, enabled: true });
    const run = await prepareCodegraphRun({
      repoDir: "/tmp/checkout",
      enabled: true,
      logger,
      prepare: preparer.prepare,
    });

    assertEquals(run.result.status, status);
    assertEquals(run.applyPrompt("the prompt"), "the prompt");
    assertEquals(run.mcpConfig(true), true);
    assertEquals(run.mcpConfig(), undefined);
  }
});

Deno.test("prepareCodegraphRun - the server follows the checkout that was indexed (Issue #2200)", async () => {
  // Two different checkouts, so the root is read from the run rather than
  // matching one fixture path by coincidence.
  for (const checkout of ["/work/repo-one", "/elsewhere/repo-two"]) {
    const logger = recordingLogger();
    const preparer = fakePreparer({
      status: "ok",
      enabled: true,
      nodeCount: 1,
      relationshipCount: 2,
    });
    const run = await prepareCodegraphRun({
      repoDir: checkout,
      enabled: true,
      logger,
      prepare: preparer.prepare,
    });

    assertEquals(preparer.calls[0]?.repoDir, checkout);
    assertEquals(codegraphServerRoot(run.mcpConfig(false)), checkout);
    assertEquals(
      codegraphServerRoot(run.mcpConfigOption(true).mcpConfig),
      checkout,
    );
  }
});

Deno.test("prepareCodegraphRun - a Gemini-routed run reports unsupported", async () => {
  const logger = recordingLogger();
  const preparer = fakePreparer({ status: "unsupported", enabled: true });
  const run = await prepareCodegraphRun({
    repoDir: "/tmp/checkout",
    enabled: true,
    agentProvider: "gemini",
    // A fixed environment rather than the process one: this host's image
    // stamp installs Claude alone, and the trial's Gemini case must not
    // depend on which agents the running image happens to carry.
    env: () => undefined,
    logger,
    prepare: preparer.prepare,
  });

  assertEquals(preparer.calls[0]?.providerId, "gemini");
  assertEquals(run.result.status, "unsupported");
  assertEquals(run.applyPrompt("p"), "p");
});

Deno.test("prepareCodegraphRun - queries are summed across invocations", async () => {
  const logger = recordingLogger();
  const preparer = fakePreparer({ status: "ok", enabled: true });
  const run = await prepareCodegraphRun({
    repoDir: "/tmp/checkout",
    enabled: true,
    logger,
    prepare: preparer.prepare,
  });

  run.record({ toolCallCounts: { mcp__codegraph__codegraph_explore: 3 } });
  run.record({ toolCallCounts: { codegraph_explore: 2, Bash: 9 } });
  assertEquals(run.result.queries, 5);

  // A run with no tally at all leaves the figure where it was — "no tally" is
  // not the same thing as "no queries".
  run.record({});
  assertEquals(run.result.queries, 5);
});

Deno.test("prepareCodegraphRun - a provider that differs is reported, not corrected", async () => {
  const logger = recordingLogger();
  const preparer = fakePreparer({ status: "ok", enabled: true });
  const run = await prepareCodegraphRun({
    repoDir: "/tmp/checkout",
    enabled: true,
    agentProvider: "claude",
    // Named rather than read from the process: this host's image stamp
    // happens to install Claude, and the test must not depend on that.
    env: () => undefined,
    logger,
    prepare: preparer.prepare,
  });

  run.record({ provider: "codex", toolCallCounts: { codegraph_explore: 1 } });
  assertEquals(run.result.queries, 1);
  assertEquals(run.result.status, "ok");
  assert(
    logger.lines.some((l) =>
      l.level === "warn" && l.message.includes("served by 'codex'")
    ),
    "the drift must be reported",
  );
});

Deno.test("prepareCodegraphRun - an unresolvable provider fails the index, not the run", async () => {
  const logger = recordingLogger();
  const preparer = fakePreparer({ status: "ok", enabled: true });
  const run = await prepareCodegraphRun({
    repoDir: "/tmp/checkout",
    enabled: true,
    agentProvider: "not-a-registered-provider",
    env: () => undefined,
    logger,
    prepare: preparer.prepare,
  });

  assertEquals(preparer.calls.length, 0, "nothing may be prepared");
  assertEquals(run.result.status, "failed");
  assertEquals(run.applyPrompt("p"), "p");
  assertEquals(run.mcpConfig(true), true);
  assert(
    logger.lines.some((l) => l.message.includes("[CODEGRAPH_UNAVAILABLE]")),
    "the fault must be logged loudly",
  );
  assert(
    logger.lines.some((l) =>
      l.message.includes("CodeGraph context: status=failed")
    ),
    "one status line is logged per run, on every path",
  );
});

Deno.test("prepareCodegraphRun - a run that names no checkout fails the index, not the run (Issue #2160)", async () => {
  const logger = recordingLogger();
  const preparer = fakePreparer({ status: "ok", enabled: true });
  const run = await prepareCodegraphRun({
    enabled: true,
    logger,
    prepare: preparer.prepare,
  });

  assertEquals(preparer.calls.length, 0, "nothing may be prepared");
  assertEquals(
    run.result.status,
    "failed",
    "the switch was on and no index was offered — never a silent `off`",
  );
  assertEquals(run.result.enabled, true);
  assertEquals(run.applyPrompt("p"), "p");
  assertEquals(run.mcpConfig(true), true, "the browser grant is untouched");
  assertEquals(run.mcpConfigOption(), {}, "no MCP configuration is written");
  assert(
    logger.lines.some((l) => l.message.includes("[CODEGRAPH_UNAVAILABLE]")),
    "the fault must be logged loudly",
  );
  assert(
    logger.lines.some((l) =>
      l.message.includes("CodeGraph context: status=failed")
    ),
    "one status line is logged per run, on every path",
  );
});

Deno.test("prepareCodegraphRun - an empty checkout path fails the index, not the run (Issue #2160)", async () => {
  // `claude_runner.ts` gates the MCP write on `mcpRequest && cwd`, which is
  // falsiness, not `undefined`: an empty checkout would otherwise be reported
  // `ok`, append the prompt line and drop the server that line names.
  const logger = recordingLogger();
  const preparer = fakePreparer({ status: "ok", enabled: true });
  const run = await prepareCodegraphRun({
    repoDir: "",
    enabled: true,
    logger,
    prepare: preparer.prepare,
  });

  assertEquals(preparer.calls.length, 0, "nothing may be prepared");
  assertEquals(run.result.status, "failed");
  assertEquals(run.applyPrompt("p"), "p", "no line without the server");
  assertEquals(run.mcpConfigOption(), {}, "no MCP configuration is written");
  assert(
    logger.lines.some((l) => l.message.includes("[CODEGRAPH_UNAVAILABLE]")),
    "the fault must be logged loudly",
  );
});

Deno.test("prepareCodegraphRun - a switched-off host with no checkout stays off (Issue #2160)", async () => {
  const logger = recordingLogger();
  const preparer = fakePreparer({ status: "off", enabled: false });
  const run = await prepareCodegraphRun({
    enabled: false,
    logger,
    prepare: preparer.prepare,
  });

  assertEquals(run.result.status, "off");
  assertEquals(run.mcpConfigOption(), {});
  assertEquals(
    logger.lines.some((l) => l.message.includes("[CODEGRAPH_UNAVAILABLE]")),
    false,
    "an off host reports no fault",
  );
});
